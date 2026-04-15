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
});
