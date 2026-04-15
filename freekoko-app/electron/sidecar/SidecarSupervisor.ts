import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import type { ServerState, ServerStatus } from '../types';
import { fetchHealth } from './SidecarClient';
import { LogCapture } from './LogCapture';

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_INITIAL_INTERVAL_MS = 250;
const HEALTH_MAX_INTERVAL_MS = 2_000;
const STOP_GRACE_MS = 5_000;
const BACKOFFS = [500, 1000, 2000, 5000, 10_000] as const;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 5;

export interface SupervisorOptions {
  /** Absolute path to the sidecar binary. If not supplied, resolved at start(). */
  binary?: string;
  /** Absolute path to the kokoro resources dir. If not supplied, resolved at start(). */
  resourcesDir?: string;
  /** TCP port for the sidecar HTTP server. Default 5002. */
  port?: number;
  /** Access to packaged flag (Electron `app.isPackaged`) — injected for testability. */
  isPackaged?: boolean;
  /** Override root dir for dev binary resolution (normally __dirname of main). */
  rootDir?: string;
  /** process.resourcesPath at runtime (only used when isPackaged). */
  resourcesPath?: string;
  /** Injected spawn (tests). Must match node:child_process spawn signature. */
  spawner?: typeof spawn;
  /** Log forwarding hook. */
  onLogEntry?: LogCapture['emit'] extends (...args: unknown[]) => unknown
    ? (entry: ReturnType<LogCapture['recent']>[number]) => void
    : never;
  /** LogCapture instance shared with the IPC logs:* handlers. */
  logCapture?: LogCapture;
}

export interface StopOptions {
  graceful?: boolean;
}

/**
 * Manages the lifecycle of the Swift freekoko-sidecar binary:
 * spawn, health polling, restart-with-backoff, graceful shutdown,
 * orphan cleanup on Electron exit.
 */
export class SidecarSupervisor extends EventEmitter {
  private state: ServerState = 'idle';
  private port: number;
  private child: ChildProcess | null = null;
  private intentionalStop = false;
  private restartTimes: number[] = [];
  private startedAt: Date | null = null;
  private errorMessage: string | undefined;
  private healthPollTimer: NodeJS.Timeout | null = null;
  private running = false;

  readonly logCapture: LogCapture;
  private spawner: typeof spawn;
  private binaryOverride?: string;
  private resourcesOverride?: string;
  private isPackaged: boolean;
  private rootDir: string;
  private resourcesPath: string;

  constructor(opts: SupervisorOptions = {}) {
    super();
    this.port = opts.port ?? 5002;
    this.binaryOverride = opts.binary;
    this.resourcesOverride = opts.resourcesDir;
    this.isPackaged = opts.isPackaged ?? false;
    this.rootDir = opts.rootDir ?? process.cwd();
    this.resourcesPath = opts.resourcesPath ?? '';
    this.spawner = opts.spawner ?? spawn;
    this.logCapture = opts.logCapture ?? new LogCapture();

    // Orphan-kill: if the Electron main process dies without running
    // before-quit (e.g. kill -9), make a best-effort SIGKILL at exit.
    process.on('exit', () => {
      if (this.child && this.child.pid && !this.child.killed) {
        try {
          process.kill(this.child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    });
  }

  // --- Public API --------------------------------------------------------

  setPort(port: number): void {
    this.port = port;
  }

  status(): ServerStatus {
    const uptimeSeconds = this.startedAt
      ? Math.max(0, Math.round((Date.now() - this.startedAt.getTime()) / 1000))
      : undefined;
    return {
      state: this.state,
      pid: this.child?.pid,
      port: this.port,
      errorMessage: this.errorMessage,
      startedAt: this.startedAt?.toISOString(),
      uptimeSeconds,
    };
  }

  async start(): Promise<ServerStatus> {
    if (this.state === 'starting' || this.state === 'running') {
      return this.status();
    }
    this.intentionalStop = false;
    this.errorMessage = undefined;
    this.setState('starting');

    const binary = this.resolveBinary();
    const resourcesDir = this.resolveResourcesDir();

    if (!fs.existsSync(binary)) {
      this.errorMessage =
        'Sidecar binary not found — run `make sidecar` to build it.';
      this.setState('error');
      return this.status();
    }
    // Resources dir is a soft warning: sidecar will emit its own error if missing,
    // and we want supervisor to still reach 'error' via health-probe timeout.

    const args = [
      '--port',
      String(this.port),
      '--resources-dir',
      resourcesDir,
      '--log-json',
    ];

    let child: ChildProcess;
    try {
      child = this.spawner(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.errorMessage = `spawn_failed: ${(err as Error).message}`;
      this.setState('error');
      return this.status();
    }
    this.child = child;
    this.startedAt = new Date();

    // Pipe stdout/stderr into LogCapture.
    if (child.stdout) this.logCapture.attachStream(child.stdout, 'stdout');
    if (child.stderr) this.logCapture.attachStream(child.stderr, 'stderr');

    // Observe port-in-use signal from sidecar logs (R9).
    const portConflictListener = (entry: {
      msg?: string;
      error?: unknown;
      [k: string]: unknown;
    }) => {
      const text = JSON.stringify(entry).toLowerCase();
      if (
        text.includes('addr_in_use') ||
        text.includes('address_in_use') ||
        text.includes('addrinuse') ||
        (typeof entry.error === 'string' &&
          entry.error.toLowerCase().includes('in_use'))
      ) {
        this.errorMessage = `Port ${this.port} is already in use.`;
        this.setState('port_in_use');
        this.hardStop();
      }
    };
    this.logCapture.on('entry', portConflictListener);

    child.on('exit', (code, signal) => {
      this.logCapture.off('entry', portConflictListener);
      const wasRunning = this.running;
      this.running = false;
      this.child = null;
      const stopping = this.intentionalStop;
      if (this.healthPollTimer) {
        clearTimeout(this.healthPollTimer);
        this.healthPollTimer = null;
      }
      // Terminal diagnostic states are sticky across child exit —
      // do not clobber them with 'idle'.
      if (
        this.state === 'port_in_use' ||
        this.state === 'crashed' ||
        this.state === 'error'
      ) {
        this.startedAt = null;
        return;
      }
      if (stopping) {
        this.setState('idle');
        this.startedAt = null;
        return;
      }
      this.errorMessage = `sidecar exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      if (wasRunning) {
        // Was healthy — treat as crash and attempt restart.
        this.scheduleRestart();
      } else {
        // Never became healthy — transition via restart backoff
        // (scheduleRestart transitions to 'crashed' once the cap is hit).
        this.scheduleRestart();
      }
    });

    child.on('error', (err) => {
      this.errorMessage = `spawn_error: ${err.message}`;
      // Don't flip state here; 'exit' will follow and drive the transition.
    });

    // Best-effort: let child survive if Electron main process is merely backgrounded.
    // We still track its pid and process.on('exit') kills it on clean exit.
    try {
      child.unref();
    } catch {
      /* ignore */
    }

    this.pollHealthUntilReady().catch(() => {
      /* errors already captured via state transitions */
    });

    return this.status();
  }

  async stop({ graceful = true }: StopOptions = {}): Promise<ServerStatus> {
    if (!this.child) {
      this.setState('idle');
      return this.status();
    }
    this.intentionalStop = true;
    this.setState('stopping');
    if (this.healthPollTimer) {
      clearTimeout(this.healthPollTimer);
      this.healthPollTimer = null;
    }
    const child = this.child;
    if (!graceful) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      return this.status();
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    await this.waitForExit(child, STOP_GRACE_MS);
    if (!child.killed && child.exitCode == null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await this.waitForExit(child, 2_000);
    }
    return this.status();
  }

  async restart(): Promise<ServerStatus> {
    await this.stop({ graceful: true });
    return this.start();
  }

  // --- Internals ---------------------------------------------------------

  private setState(next: ServerState): void {
    if (this.state === next) return;
    this.state = next;
    if (next === 'running') {
      // Clean slate for restart backoff after a stable run (see scheduleRestart).
    }
    const payload = this.status();
    this.emit('status', payload);
  }

  private resolveBinary(): string {
    if (this.binaryOverride) return this.binaryOverride;
    if (this.isPackaged) {
      return path.join(this.resourcesPath, 'sidecar', 'freekoko-sidecar');
    }
    // Dev: rootDir is the main process __dirname (freekoko-app/out/main).
    // Walk up three levels to the repo root.
    // Prefer the xcodebuild output (ships the mlx-swift_Cmlx.bundle with metallib
    // alongside the binary, which MLX needs at runtime) over the swift-build output.
    const repoRoot = path.resolve(this.rootDir, '..', '..', '..');
    const xcodeBinary = path.join(
      repoRoot,
      'freekoko-sidecar',
      '.build',
      'xcode',
      'Build',
      'Products',
      'Debug',
      'freekoko-sidecar'
    );
    if (fs.existsSync(xcodeBinary)) return xcodeBinary;
    return path.join(
      repoRoot,
      'freekoko-sidecar',
      '.build',
      'debug',
      'freekoko-sidecar'
    );
  }

  private resolveResourcesDir(): string {
    if (this.resourcesOverride) return this.resourcesOverride;
    if (this.isPackaged) {
      return path.join(this.resourcesPath, 'kokoro');
    }
    return path.resolve(this.rootDir, '..', '..', '..', 'upstream-kokoro', 'Resources');
  }

  private async pollHealthUntilReady(): Promise<void> {
    const startTs = Date.now();
    let interval = HEALTH_INITIAL_INTERVAL_MS;
    while (this.state === 'starting') {
      const elapsed = Date.now() - startTs;
      if (elapsed > HEALTH_TIMEOUT_MS) {
        if (this.state === 'starting') {
          if (!this.errorMessage) this.errorMessage = 'health_probe_timeout';
          this.setState('error');
          this.hardStop();
        }
        return;
      }
      try {
        const health = await fetchHealth(this.port, 1_000);
        if (health?.status === 'ok' && health.model_loaded) {
          this.running = true;
          // Reset restart counter after 60s of stable running.
          setTimeout(() => {
            if (this.running) this.restartTimes = [];
          }, RESTART_WINDOW_MS).unref?.();
          this.setState('running');
          return;
        }
        // Loading or not-ok: keep polling.
      } catch (err) {
        // Connection refused is expected while the child is booting.
        // If response parsing or unexpected HTTP status, log for the port-conflict detector.
        const msg = (err as Error).message ?? '';
        if (msg.includes('unexpected_status')) {
          // Someone else is listening on this port — treat as conflict.
          this.errorMessage = `Port ${this.port} is already in use (unexpected response).`;
          this.setState('port_in_use');
          this.hardStop();
          return;
        }
      }
      await new Promise((res) => {
        this.healthPollTimer = setTimeout(res, interval);
        this.healthPollTimer.unref?.();
      });
      interval = Math.min(Math.round(interval * 1.5), HEALTH_MAX_INTERVAL_MS);
    }
  }

  private scheduleRestart(): void {
    const now = Date.now();
    // Drop restart timestamps older than the window.
    this.restartTimes = this.restartTimes.filter(
      (ts) => now - ts < RESTART_WINDOW_MS
    );
    if (this.restartTimes.length >= MAX_RESTARTS) {
      this.errorMessage = `sidecar crashed ${MAX_RESTARTS} times in ${Math.round(
        RESTART_WINDOW_MS / 1000
      )}s; giving up`;
      this.setState('crashed');
      return;
    }
    const delay = BACKOFFS[Math.min(this.restartTimes.length, BACKOFFS.length - 1)];
    this.restartTimes.push(now);
    this.setState('crashed');
    const t = setTimeout(() => {
      if (this.intentionalStop) return;
      this.start().catch(() => {
        /* state already reflected */
      });
    }, delay);
    t.unref?.();
  }

  private hardStop(): void {
    this.intentionalStop = true;
    const child = this.child;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      if (child.exitCode == null && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, STOP_GRACE_MS).unref?.();
  }

  private waitForExit(child: ChildProcess, ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Only short-circuit when the process has fully exited. `child.killed`
      // merely indicates a signal was sent; the 'exit' event is still pending.
      if (child.exitCode != null) return resolve();
      const done = () => {
        cleanup();
        resolve();
      };
      const t = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const cleanup = () => {
        clearTimeout(t);
        child.off('exit', done);
      };
      child.once('exit', done);
    });
  }
}
