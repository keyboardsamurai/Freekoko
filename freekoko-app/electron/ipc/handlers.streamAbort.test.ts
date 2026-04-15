import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// -----------------------------------------------------------------------------
// Mock the bits of `electron` the handler module imports. We only need
// ipcMain (registry of handle callbacks) + minimal app/dialog/shell/BrowserWindow
// stubs because the streaming handler reaches for them at module load.
//
// The mocks live in `vi.hoisted` because `vi.mock` factories run at
// module-load time (before `import` statements), and we need to share the
// fake registry between the test body and the mock factory.
// -----------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  interface FakeIpcMain {
    handlers: Map<string, (evt: unknown, ...args: unknown[]) => unknown>;
    handle: (channel: string, cb: (evt: unknown, ...args: unknown[]) => unknown) => void;
    removeHandler: (channel: string) => void;
    invoke: (channel: string, evt: unknown, ...args: unknown[]) => Promise<unknown>;
  }
  const fakeIpcMain: FakeIpcMain = {
    handlers: new Map(),
    handle(channel, cb) {
      this.handlers.set(channel, cb);
    },
    removeHandler(channel) {
      this.handlers.delete(channel);
    },
    async invoke(channel, evt, ...args) {
      const cb = this.handlers.get(channel);
      if (!cb) throw new Error(`no handler for ${channel}`);
      return cb(evt, ...args);
    },
  };
  return {
    fakeIpcMain,
    fetchTTSStreamMock: vi.fn(),
  };
});

vi.mock('electron', () => {
  return {
    ipcMain: hoisted.fakeIpcMain,
    BrowserWindow: {
      getAllWindows: () => [],
    },
    app: {
      // The handlers module pulls userData synchronously; we don't use it
      // because tests inject their own HistoryStore.
      getPath: () => os.tmpdir(),
      getVersion: () => '0.1.0-test',
    },
    dialog: {
      showSaveDialog: vi.fn(),
      showOpenDialog: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(),
      openPath: vi.fn(),
    },
  };
});

// `electron-log` complains about missing app paths in test env; stub.
vi.mock('electron-log', () => ({
  default: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// fetchTTSStream is what the handler calls into. Mock at module boundary.
vi.mock('../sidecar/SidecarClient', async () => {
  const actual: typeof import('../sidecar/SidecarClient') =
    await vi.importActual('../sidecar/SidecarClient');
  return {
    ...actual,
    fetchTTSStream: (
      ...args: Parameters<typeof actual.fetchTTSStream>
    ) => hoisted.fetchTTSStreamMock(...args),
  };
});

const { fakeIpcMain, fetchTTSStreamMock } = hoisted;

// ----- Now we can import the module under test. -----------------------------

import { registerIpcHandlers, unregisterIpcHandlers } from './handlers';
import { HistoryStore } from '../history/HistoryStore';
import { IPC } from '../types';
import type { TtsErrorEvent, TtsRequest } from '../types';

// -----------------------------------------------------------------------------
// Test scaffolding — make a temp HistoryStore + fake supervisor/settings/sender.
// -----------------------------------------------------------------------------

interface SentEvent {
  channel: string;
  payload: unknown;
}

function makeTempDir(): string {
  return path.join(os.tmpdir(), `freekoko-handlers-${crypto.randomUUID()}`);
}

function makeFakeSupervisor() {
  return {
    status: () => ({
      state: 'running' as const,
      port: 5099,
      pid: 12345,
    }),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  };
}

function makeFakeSettings() {
  const store: Record<string, unknown> = {
    defaultVoice: 'af_heart',
    defaultSpeed: 1.0,
    outputDir: '/tmp/out',
  };
  return {
    get: (k: string) => store[k],
    setMany: (patch: Record<string, unknown>) => {
      Object.assign(store, patch);
      return store;
    },
    getAll: () => ({ ...store }),
  };
}

function makeFakeLogCapture() {
  return {
    recent: vi.fn(() => []),
    clear: vi.fn(),
  };
}

function makeFakeSender(captured: SentEvent[]) {
  return {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => {
      captured.push({ channel, payload });
    },
  };
}

// -----------------------------------------------------------------------------
// The actual test.
// -----------------------------------------------------------------------------

describe('TTS_GENERATE_STREAM — abort BEFORE preamble', () => {
  let dir: string;
  let history: HistoryStore;
  let captured: SentEvent[];

  beforeEach(async () => {
    dir = makeTempDir();
    history = new HistoryStore(dir);
    await history.init();
    captured = [];
    fakeIpcMain.handlers.clear();
    fetchTTSStreamMock.mockReset();

    registerIpcHandlers({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supervisor: makeFakeSupervisor() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settings: makeFakeSettings() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logCapture: makeFakeLogCapture() as any,
      showMainWindow: vi.fn(),
      historyStore: history,
    });
  });

  afterEach(async () => {
    unregisterIpcHandlers();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('aborts before the preamble parses, emits TtsErrorEvent, persists nothing', async () => {
    // Resolved when our test fixture has captured the requestId from the
    // initial RPC return value, so the abort signal can fire mid-fetch.
    let abortObservedSignal: AbortSignal | null = null;
    const fetchEntered = new Promise<void>((resolve) => {
      // The fake fetchTTSStream resolves only after the abort has fired,
      // and rejects with an AbortError to mirror what real undici-fetch
      // does on an already-aborted signal.
      fetchTTSStreamMock.mockImplementation(async (
        _port: number,
        _req: TtsRequest,
        _onFrame: (frame: unknown) => void,
        signal: AbortSignal
      ) => {
        abortObservedSignal = signal;
        resolve();
        await new Promise<void>((r) => {
          if (signal.aborted) return r();
          signal.addEventListener('abort', () => r(), { once: true });
        });
        // Mirror real undici behaviour: throw an AbortError when the signal
        // fires. The handler catches this and routes through the
        // `controller.signal.aborted` branch, NOT the firstError branch.
        const e = new Error('The operation was aborted.');
        e.name = 'AbortError';
        throw e;
      });
    });

    const fakeSender = makeFakeSender(captured);

    // Kick off the stream RPC. Returns immediately with `{ requestId }`.
    const startPromise = fakeIpcMain.invoke(
      IPC.TTS_GENERATE_STREAM,
      { sender: fakeSender },
      { text: 'hello world', voice: 'af_heart', speed: 1.0 }
    );
    const startRes = (await startPromise) as { requestId: string };
    expect(typeof startRes.requestId).toBe('string');
    expect(startRes.requestId.length).toBeGreaterThan(0);

    // Wait until the underlying fetchTTSStream is in-flight so we know the
    // AbortController is wired up.
    await fetchEntered;
    expect(abortObservedSignal).not.toBeNull();
    expect(abortObservedSignal!.aborted).toBe(false);

    // Abort. This goes through TTS_ABORT (so we exercise the same path the
    // renderer uses, not just .abort() on the controller).
    const abortAck = await fakeIpcMain.invoke(
      IPC.TTS_ABORT,
      { sender: fakeSender },
      { requestId: startRes.requestId }
    );
    expect(abortAck).toMatchObject({ ok: true });
    // The abort should immediately propagate to the in-flight fetch's signal.
    expect(abortObservedSignal!.aborted).toBe(true);

    // Wait for the background finalize promise to flush. The handler needs
    // microtasks + promise-then chains to: catch AbortError → route to
    // 'aborted' → emit TtsErrorEvent. We poll up to ~100ms for the event.
    for (let attempt = 0; attempt < 50 && captured.length === 0; attempt++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // ASSERT 1 — TtsErrorEvent emitted, code 'aborted'.
    expect(captured.length).toBeGreaterThan(0);
    const errorEvts = captured.filter((c) => c.channel === IPC.ON_TTS_ERROR);
    expect(errorEvts).toHaveLength(1);
    const errPayload = errorEvts[0].payload as TtsErrorEvent;
    expect(errPayload.requestId).toBe(startRes.requestId);
    expect(errPayload.code).toBe('aborted');

    // ASSERT 2 — no chunks emitted (we aborted before any preamble parsing).
    const chunkEvts = captured.filter((c) => c.channel === IPC.ON_TTS_CHUNK);
    expect(chunkEvts).toHaveLength(0);

    // ASSERT 3 — no `tts:done` (no partial WAV was created).
    const doneEvts = captured.filter((c) => c.channel === IPC.ON_TTS_DONE);
    expect(doneEvts).toHaveLength(0);

    // ASSERT 4 — no orphan WAV file written. The history store's directory
    // should contain at most the index.json the init created — never any
    // .wav file.
    const entries = await fsp.readdir(dir);
    const wavs = entries.filter((e) => e.endsWith('.wav'));
    expect(wavs).toEqual([]);

    // Belt-and-braces: every file present is the index, and the index is
    // empty.
    expect(entries.filter((e) => e !== 'index.json' && e !== 'index.json.tmp')).toEqual([]);
    const idxRaw = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
    expect(JSON.parse(idxRaw)).toEqual([]);

    // ASSERT 5 — the in-memory HistoryStore agrees: zero items.
    expect(await history.list(50, 0)).toEqual([]);
  });
});
