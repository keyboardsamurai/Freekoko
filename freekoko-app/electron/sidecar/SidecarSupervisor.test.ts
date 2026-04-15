import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fs from 'node:fs';

import { SidecarSupervisor } from './SidecarSupervisor';

// Fake child_process.ChildProcess — EventEmitter with stdout/stderr streams,
// kill() toggling the exitCode + emitting 'exit'.
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    killed: boolean;
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => void;
    unref: () => void;
    off: EventEmitter['off'];
  };
  child.pid = 9999;
  child.exitCode = null;
  child.killed = false;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = (signal?: string) => {
    if (child.exitCode != null) return;
    child.killed = true;
    // Real ChildProcess sets exitCode only after the process actually exits,
    // which the kernel schedules asynchronously. Mirror that here so
    // supervisor's waitForExit doesn't short-circuit.
    setImmediate(() => {
      child.exitCode = signal === 'SIGKILL' ? 137 : 0;
      child.emit('exit', child.exitCode, signal ?? null);
    });
  };
  child.unref = () => undefined;
  return child;
}

describe('SidecarSupervisor', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    // Block real network calls — supervisor's health poll uses `fetch`.
    // We stub it with a never-resolving promise so state stays in "starting".
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            /* never resolves */
          })
      )
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('transitions idle → starting when start() is called', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child as never) as unknown as typeof import('node:child_process').spawn;
    const sup = new SidecarSupervisor({
      port: 5002,
      binary: '/fake/sidecar',
      resourcesDir: '/fake/resources',
      spawner: fakeSpawn,
    });
    const states: string[] = [];
    sup.on('status', (s) => states.push(s.state));

    await sup.start();

    expect(fakeSpawn).toHaveBeenCalledOnce();
    // Should be starting (health probe pending).
    expect(sup.status().state).toBe('starting');
    expect(states).toContain('starting');
  });

  it('transitions to error when binary path does not exist', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const fakeSpawn = vi.fn();
    const sup = new SidecarSupervisor({
      port: 5002,
      binary: '/does/not/exist',
      resourcesDir: '/fake/resources',
      spawner: fakeSpawn as unknown as typeof import('node:child_process').spawn,
    });

    await sup.start();

    expect(fakeSpawn).not.toHaveBeenCalled();
    expect(sup.status().state).toBe('error');
    expect(sup.status().errorMessage).toMatch(/sidecar binary not found/i);
  });

  it('intentional stop transitions running/starting → idle', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child as never) as unknown as typeof import('node:child_process').spawn;
    const sup = new SidecarSupervisor({
      port: 5002,
      binary: '/fake/sidecar',
      resourcesDir: '/fake/resources',
      spawner: fakeSpawn,
    });
    await sup.start();
    expect(sup.status().state).toBe('starting');

    const stopPromise = sup.stop({ graceful: true });
    // Child.kill triggers the 'exit' event on next tick.
    await stopPromise;
    expect(sup.status().state).toBe('idle');
  });

  it('detects port_in_use from sidecar logs', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child as never) as unknown as typeof import('node:child_process').spawn;
    const sup = new SidecarSupervisor({
      port: 5002,
      binary: '/fake/sidecar',
      resourcesDir: '/fake/resources',
      spawner: fakeSpawn,
    });
    await sup.start();

    // Simulate sidecar log line indicating port conflict.
    sup.logCapture.ingestLine(
      '{"ts":"x","level":"error","msg":"server_start_failed","error":"address_in_use","port":5002}'
    );
    // Wait a tick for event propagation.
    await new Promise((r) => setImmediate(r));
    expect(sup.status().state).toBe('port_in_use');
  });

  it('status() returns pid, port, and startedAt when running', async () => {
    const child = makeFakeChild();
    const fakeSpawn = vi.fn(() => child as never) as unknown as typeof import('node:child_process').spawn;
    const sup = new SidecarSupervisor({
      port: 5050,
      binary: '/fake/sidecar',
      resourcesDir: '/fake/resources',
      spawner: fakeSpawn,
    });
    await sup.start();
    const status = sup.status();
    expect(status.port).toBe(5050);
    expect(status.pid).toBe(9999);
    expect(status.startedAt).toBeDefined();
  });

  // --- Restart backoff ---------------------------------------------------
  //
  // These cases lock in the documented backoff schedule
  // [500, 1000, 2000, 5000, 10000] ms and the 5-restarts/60s cap (which
  // transitions the supervisor into a permanent `crashed` state).
  //
  // Strategy: fake-timers + a spawner that returns a fresh fake child each
  // call, so we can drive successive crash/restart cycles deterministically
  // without any real sockets or child processes.

  describe('restart backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Build a spawner that hands out a fresh fake child per call. */
    function freshSpawner() {
      const children: ReturnType<typeof makeFakeChild>[] = [];
      const spawner = vi.fn(() => {
        const c = makeFakeChild();
        children.push(c);
        return c as never;
      }) as unknown as typeof import('node:child_process').spawn;
      return { spawner, children };
    }

    /** Simulate a crash on the given fake child: exit with a non-zero code. */
    function crash(child: ReturnType<typeof makeFakeChild>) {
      child.exitCode = 1;
      child.emit('exit', 1, null);
    }

    it('schedules restarts with the exact 500/1000/2000/5000/10000 ms progression', async () => {
      const { spawner, children } = freshSpawner();
      const sup = new SidecarSupervisor({
        port: 5002,
        binary: '/fake/sidecar',
        resourcesDir: '/fake/resources',
        spawner,
      });
      const states: string[] = [];
      sup.on('status', (s) => states.push(s.state));

      await sup.start();
      expect(spawner).toHaveBeenCalledTimes(1);

      const EXPECTED_BACKOFFS = [500, 1000, 2000, 5000, 10_000];

      // Crash → wait <delay> → confirm no spawn yet → advance to <delay>
      // → confirm exactly one new spawn happened.
      for (let i = 0; i < EXPECTED_BACKOFFS.length; i++) {
        const delay = EXPECTED_BACKOFFS[i];
        const spawnsBefore = spawner.mock.calls.length;

        crash(children[i]);
        // scheduleRestart pushes a timer and flips state → crashed.
        expect(sup.status().state).toBe('crashed');

        // One tick before the scheduled delay: no new spawn yet.
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(spawner.mock.calls.length).toBe(spawnsBefore);

        // Advance past the remaining 1ms — respawn fires.
        await vi.advanceTimersByTimeAsync(1);
        expect(spawner.mock.calls.length).toBe(spawnsBefore + 1);
      }
    });

    it('caps at 5 restarts in a 60s window and sticks to `crashed`', async () => {
      const { spawner, children } = freshSpawner();
      const sup = new SidecarSupervisor({
        port: 5002,
        binary: '/fake/sidecar',
        resourcesDir: '/fake/resources',
        spawner,
      });
      await sup.start();

      const EXPECTED_BACKOFFS = [500, 1000, 2000, 5000, 10_000];
      // Drive 5 crash→restart cycles. After cycle N, we've had N+1 spawns
      // (initial + N restarts).
      for (let i = 0; i < EXPECTED_BACKOFFS.length; i++) {
        crash(children[i]);
        await vi.advanceTimersByTimeAsync(EXPECTED_BACKOFFS[i]);
      }
      // Initial spawn + 5 restart spawns = 6 total.
      expect(spawner).toHaveBeenCalledTimes(6);

      // The 6th child crashes. Now restartTimes.length === 5 ≥ MAX_RESTARTS
      // so scheduleRestart must short-circuit to 'crashed' with no timer.
      crash(children[5]);
      expect(sup.status().state).toBe('crashed');
      expect(sup.status().errorMessage).toMatch(/crashed 5 times/i);

      // No matter how much time elapses within-window, no 7th spawn should
      // ever happen (other than by manual intervention via start()/restart()).
      await vi.advanceTimersByTimeAsync(30_000);
      expect(spawner).toHaveBeenCalledTimes(6);
      expect(sup.status().state).toBe('crashed');
    });

    it('resets the restart counter after a stable run and the 60s window elapses', async () => {
      // To exercise the reset path we need fetchHealth to resolve
      // successfully so pollHealthUntilReady flips the state to 'running'
      // and schedules the 60s reset timer. Replace the module-level fetch
      // stub (never-resolving) with an OK health response just for this
      // test.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ status: 'ok', model_loaded: true }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            )
        )
      );

      const { spawner, children } = freshSpawner();
      const sup = new SidecarSupervisor({
        port: 5002,
        binary: '/fake/sidecar',
        resourcesDir: '/fake/resources',
        spawner,
      });
      await sup.start();

      // Drain microtasks + the health-poll interval so the supervisor
      // observes the healthy response. The first poll happens without a
      // setTimeout delay (the while loop runs immediately), so just
      // flushing microtasks is enough.
      await vi.advanceTimersByTimeAsync(0);
      // A few iterations of the microtask queue for the async fetch chain.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(sup.status().state).toBe('running');

      // Crash once to push a timestamp.
      crash(children[0]);
      expect(sup.status().state).toBe('crashed');
      // Fast-forward past the 60s reset window AND past the first backoff
      // so the respawn fires and the reset timer runs. The scheduleRestart
      // filter (ts-older-than-window) alone would also clear the single
      // entry on the NEXT crash, but explicitly advancing past the reset
      // timer exercises the intended code path.
      await vi.advanceTimersByTimeAsync(61_000);
      // At this point: respawn happened (500ms), healthy again, reset
      // timer fired (60s after becoming healthy the first time AND the
      // second time).
      expect(sup.status().state).toBe('running');

      // A fresh crash after the window should start backoff at 500ms
      // again — i.e. the counter behaves as if this were the first crash.
      const spawnsBefore = spawner.mock.calls.length;
      const lastChild = children[children.length - 1];
      crash(lastChild);
      expect(sup.status().state).toBe('crashed');
      await vi.advanceTimersByTimeAsync(499);
      expect(spawner.mock.calls.length).toBe(spawnsBefore);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawner.mock.calls.length).toBe(spawnsBefore + 1);
    });
  });
});
