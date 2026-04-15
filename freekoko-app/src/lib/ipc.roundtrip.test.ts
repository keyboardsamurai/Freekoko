// @vitest-environment happy-dom
//
// Round-trip a payload across the preload boundary. We don't spin up a
// real Electron context — instead we install a fake `window.electronAPI`
// that mimics the contract `preload.ts` exposes, then assert that the
// renderer wrappers in `src/lib/ipc.ts` correctly:
//
//   1. survive a Uint8Array payload byte-for-byte (covers the
//      `readHistoryWav` collapse from a 3-way fallback to the canonical
//      `{ ok: true, bytes }` shape), and
//   2. detect `IpcError` returns via `isIpcError()` and surface them as
//      errors from the renderer wrappers — never as `[]`, `null`, or
//      `undefined`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  abortTTS,
  clearHistory,
  deleteHistory,
  generateTTS,
  generateTTSStream,
  isIpcError,
  listHistory,
  listVoices,
  readHistoryWav,
  saveHistoryWav,
} from './ipc';
import type { IpcError } from './types';

type ApiOverrides = Partial<Window['electronAPI']>;

function makeApi(overrides: ApiOverrides = {}): Window['electronAPI'] {
  const noop = vi.fn();
  const base: Window['electronAPI'] = {
    supervisor: {
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      status: vi.fn(),
    },
    tts: {
      generate: vi.fn(),
      generateStream: vi.fn(),
      abort: vi.fn(),
      voices: vi.fn(),
    },
    history: {
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      saveWav: vi.fn(),
      readWav: vi.fn(),
      clear: vi.fn(),
    },
    settings: {
      get: vi.fn(),
      set: vi.fn(),
      getAll: vi.fn(),
      chooseDirectory: vi.fn(),
      openPath: vi.fn(),
    },
    logs: { recent: vi.fn(), clear: vi.fn() },
    window: { showMain: vi.fn() },
    app: { getVersion: vi.fn(), openUrl: vi.fn() },
    onServerStatus: () => noop,
    onLogLine: () => noop,
    onSettingsChanged: () => noop,
    onTtsProgress: () => noop,
    onTtsChunk: () => noop,
    onTtsDone: () => noop,
    onTtsError: () => noop,
    onNavigate: () => noop,
    ...overrides,
  };
  return base;
}

function installApi(api: Window['electronAPI']): void {
  // happy-dom exposes window on globalThis.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.window) g.window.electronAPI = api;
  g.electronAPI = api;
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.window) delete g.window.electronAPI;
  delete g.electronAPI;
});

// ---------------------------------------------------------------------------
// Success-shape: Uint8Array survives byte-identically across the boundary.
// ---------------------------------------------------------------------------

describe('IPC round-trip — success shapes', () => {
  it('readHistoryWav: Uint8Array bytes round-trip byte-identically', async () => {
    // Build a payload whose every byte is non-zero so we can detect any
    // accidental zero-fill / truncation.
    const original = new Uint8Array(1024);
    for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 7) & 0xff;

    const api = makeApi({
      history: {
        list: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        saveWav: vi.fn(),
        readWav: vi.fn().mockResolvedValue({ ok: true, bytes: original }),
        clear: vi.fn(),
      },
    });
    installApi(api);

    const got = await readHistoryWav('abc');
    expect(got).toBeInstanceOf(Uint8Array);
    expect(got).not.toBeNull();
    expect(got!.byteLength).toBe(original.byteLength);
    for (let i = 0; i < original.length; i++) {
      expect(got![i], `byte ${i}`).toBe(original[i]);
    }
  });

  it('listHistory: array success shape passes through unchanged', async () => {
    const items = [
      {
        id: 'x',
        createdAt: '2026-01-01T00:00:00Z',
        text: 'hi',
        voice: 'af_heart',
        speed: 1,
        sampleCount: 24000,
        durationMs: 1000,
        wavFilename: 'x.wav',
        previewText: 'hi',
      },
    ];
    const api = makeApi({
      history: {
        list: vi.fn().mockResolvedValue(items),
        get: vi.fn(),
        delete: vi.fn(),
        saveWav: vi.fn(),
        readWav: vi.fn(),
        clear: vi.fn(),
      },
    });
    installApi(api);
    const got = await listHistory();
    expect(isIpcError(got)).toBe(false);
    expect(got).toEqual(items);
  });

  it('generateTTS: well-formed success payload passes through unchanged', async () => {
    const item = {
      id: 'hist-1',
      createdAt: '2026-01-01T00:00:00Z',
      text: 'hello',
      voice: 'af_heart',
      speed: 1,
      sampleCount: 24000,
      durationMs: 1000,
      wavFilename: 'hist-1.wav',
      previewText: 'hello',
    };
    const payload = { ok: true as const, item, wavPath: '/tmp/hist-1.wav' };
    const api = makeApi({
      tts: {
        generate: vi.fn().mockResolvedValue(payload),
        generateStream: vi.fn(),
        abort: vi.fn(),
        voices: vi.fn(),
      },
    });
    installApi(api);
    const got = await generateTTS({ text: 'hello', voice: 'af_heart', speed: 1 });
    expect(isIpcError(got)).toBe(false);
    expect(got).toEqual(payload);
  });

  it('generateTTSStream: well-formed success payload passes through unchanged', async () => {
    const api = makeApi({
      tts: {
        generate: vi.fn(),
        generateStream: vi.fn().mockResolvedValue({ requestId: 'req-abc' }),
        abort: vi.fn(),
        voices: vi.fn(),
      },
    });
    installApi(api);
    const got = await generateTTSStream({ text: 'hi', voice: 'x', speed: 1 });
    expect(isIpcError(got)).toBe(false);
    expect(got).toEqual({ requestId: 'req-abc' });
  });

  it('saveHistoryWav: canceled is faithfully propagated as a non-error', async () => {
    const api = makeApi({
      history: {
        list: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        saveWav: vi.fn().mockResolvedValue({ ok: true, canceled: true }),
        readWav: vi.fn(),
        clear: vi.fn(),
      },
    });
    installApi(api);
    const got = await saveHistoryWav('x');
    expect(got.ok).toBe(true);
    expect(got.canceled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure-shape: IpcError is detected and surfaced — never collapsed.
// ---------------------------------------------------------------------------

describe('IPC round-trip — IpcError shapes', () => {
  const ERR: IpcError = { error: 'sidecar_unreachable', message: 'boom' };

  it('isIpcError() recognises the canonical {error: string, message?: string} shape', () => {
    expect(isIpcError(ERR)).toBe(true);
    expect(isIpcError({ error: 'x' })).toBe(true);
    expect(isIpcError({ error: 1 })).toBe(false); // error must be a string
    expect(isIpcError(null)).toBe(false);
    expect(isIpcError([])).toBe(false);
    expect(isIpcError({ message: 'x' })).toBe(false);
    expect(isIpcError(undefined)).toBe(false);
  });

  it('listHistory: surfaces IpcError instead of returning [] (release-blocker fix)', async () => {
    const api = makeApi({
      history: {
        list: vi.fn().mockResolvedValue(ERR),
        get: vi.fn(),
        delete: vi.fn(),
        saveWav: vi.fn(),
        readWav: vi.fn(),
        clear: vi.fn(),
      },
    });
    installApi(api);
    const got = await listHistory();
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('sidecar_unreachable');
    // CRUCIAL: must not be silently coerced to an empty array.
    expect(Array.isArray(got)).toBe(false);
  });

  it('listVoices: surfaces IpcError instead of returning []', async () => {
    const api = makeApi({
      tts: {
        generate: vi.fn(),
        generateStream: vi.fn(),
        abort: vi.fn(),
        voices: vi.fn().mockResolvedValue(ERR),
      },
    });
    installApi(api);
    const got = await listVoices();
    expect(isIpcError(got)).toBe(true);
    expect(Array.isArray(got)).toBe(false);
  });

  it('readHistoryWav: returns null on IpcError (documented contract)', async () => {
    const api = makeApi({
      history: {
        list: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        saveWav: vi.fn(),
        readWav: vi.fn().mockResolvedValue(ERR),
        clear: vi.fn(),
      },
    });
    installApi(api);
    const got = await readHistoryWav('nope');
    expect(got).toBeNull();
  });

  it('generateTTS: IpcError is propagated with original code', async () => {
    const api = makeApi({
      tts: {
        generate: vi.fn().mockResolvedValue({
          error: 'voice_not_found',
          message: 'X',
        }),
        generateStream: vi.fn(),
        abort: vi.fn(),
        voices: vi.fn(),
      },
    });
    installApi(api);
    const got = await generateTTS({ text: 'a', voice: 'x', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('voice_not_found');
  });

  it('generateTTSStream: IpcError is propagated', async () => {
    const api = makeApi({
      tts: {
        generate: vi.fn(),
        generateStream: vi.fn().mockResolvedValue(ERR),
        abort: vi.fn(),
        voices: vi.fn(),
      },
    });
    installApi(api);
    const got = await generateTTSStream({ text: 'a', voice: 'x', speed: 1 });
    expect(isIpcError(got)).toBe(true);
  });

  it('abortTTS: invalid_request_id IpcError is propagated, not silently swallowed', async () => {
    const api = makeApi({
      tts: {
        generate: vi.fn(),
        generateStream: vi.fn(),
        abort: vi
          .fn()
          .mockResolvedValue({ error: 'invalid_request_id' }),
        voices: vi.fn(),
      },
    });
    installApi(api);
    const got = await abortTTS('');
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('invalid_request_id');
  });

  it('deleteHistory: IpcError surfaces as `false` (existing boolean contract preserved)', async () => {
    const api = makeApi({
      history: {
        list: vi.fn(),
        get: vi.fn(),
        delete: vi.fn().mockResolvedValue(ERR),
        saveWav: vi.fn(),
        readWav: vi.fn(),
        clear: vi.fn(),
      },
    });
    installApi(api);
    const ok = await deleteHistory('x');
    expect(ok).toBe(false);
  });

  it('clearHistory: IpcError surfaces with `error` field populated', async () => {
    const api = makeApi({
      history: {
        list: vi.fn(),
        get: vi.fn(),
        delete: vi.fn(),
        saveWav: vi.fn(),
        readWav: vi.fn(),
        clear: vi.fn().mockResolvedValue({
          error: 'confirmation_required',
          message: 'Pass {confirmed:true}',
        }),
      },
    });
    installApi(api);
    const got = await clearHistory(false);
    expect(got.ok).toBe(false);
    expect(got.error).toBe('confirmation_required');
  });
});

// ---------------------------------------------------------------------------
// Promise rejections (e.g. preload throws synchronously) → wrappers must
// translate to a synthetic IpcError, never bubble unhandled.
// ---------------------------------------------------------------------------

describe('IPC round-trip — preload rejections', () => {
  beforeEach(() => {
    // Suppress console noise from the wrappers' final `.catch`.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('listHistory: preload rejection becomes an `ipc_failed` IpcError', async () => {
    const api = makeApi({
      history: {
        list: vi.fn().mockRejectedValue(new Error('bridge gone')),
        get: vi.fn(),
        delete: vi.fn(),
        saveWav: vi.fn(),
        readWav: vi.fn(),
        clear: vi.fn(),
      },
    });
    installApi(api);
    const got = await listHistory();
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('ipc_failed');
    expect((got as IpcError).message).toContain('bridge gone');
  });
});

// ---------------------------------------------------------------------------
// Malformed success payloads — must be downgraded to `unknown_response`, not
// trusted based on TS typings alone. Guards renderer code (GenerateView,
// HistoryStore) from crashing on a dropped field or typo across the boundary.
// ---------------------------------------------------------------------------

describe('IPC round-trip — malformed success shapes', () => {
  const goodItem = {
    id: 'hist-1',
    createdAt: '2026-01-01T00:00:00Z',
    text: 'hello',
    voice: 'af_heart',
    speed: 1,
    sampleCount: 24000,
    durationMs: 1000,
    wavFilename: 'hist-1.wav',
    previewText: 'hello',
  };

  function mkGenerateApi(mockValue: unknown): Window['electronAPI'] {
    return makeApi({
      tts: {
        generate: vi.fn().mockResolvedValue(mockValue),
        generateStream: vi.fn(),
        abort: vi.fn(),
        voices: vi.fn(),
      },
    });
  }

  function mkStreamApi(mockValue: unknown): Window['electronAPI'] {
    return makeApi({
      tts: {
        generate: vi.fn(),
        generateStream: vi.fn().mockResolvedValue(mockValue),
        abort: vi.fn(),
        voices: vi.fn(),
      },
    });
  }

  it('generateTTS: payload missing wavPath becomes unknown_response', async () => {
    installApi(mkGenerateApi({ ok: true, item: goodItem }));
    const got = await generateTTS({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });

  it('generateTTS: payload with empty wavPath becomes unknown_response', async () => {
    installApi(mkGenerateApi({ ok: true, item: goodItem, wavPath: '' }));
    const got = await generateTTS({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });

  it('generateTTS: payload with ok !== true becomes unknown_response', async () => {
    installApi(
      mkGenerateApi({ ok: false, item: goodItem, wavPath: '/tmp/x.wav' })
    );
    const got = await generateTTS({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });

  it('generateTTS: payload missing item becomes unknown_response', async () => {
    installApi(mkGenerateApi({ ok: true, wavPath: '/tmp/x.wav' }));
    const got = await generateTTS({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });

  it('generateTTS: payload with malformed item (missing id) becomes unknown_response', async () => {
    const { id: _omit, ...itemWithoutId } = goodItem;
    installApi(
      mkGenerateApi({ ok: true, item: itemWithoutId, wavPath: '/tmp/x.wav' })
    );
    const got = await generateTTS({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });

  it('generateTTSStream: payload missing requestId becomes unknown_response', async () => {
    installApi(mkStreamApi({}));
    const got = await generateTTSStream({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });

  it('generateTTSStream: payload with empty requestId becomes unknown_response', async () => {
    installApi(mkStreamApi({ requestId: '' }));
    const got = await generateTTSStream({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });

  it('generateTTSStream: payload with non-string requestId becomes unknown_response', async () => {
    installApi(mkStreamApi({ requestId: 42 }));
    const got = await generateTTSStream({ text: 'x', voice: 'y', speed: 1 });
    expect(isIpcError(got)).toBe(true);
    expect((got as IpcError).error).toBe('unknown_response');
  });
});
