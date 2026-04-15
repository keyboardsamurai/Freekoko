// @vitest-environment happy-dom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { AudioPlayer } from './AudioPlayer';
import type {
  HistoryItem,
  TtsChunkEvent,
  TtsDoneEvent,
  TtsErrorEvent,
} from '../lib/types';

// --- AudioContext stub ------------------------------------------------------
//
// happy-dom (and JSDOM) ship no Web Audio implementation. We stub the minimum
// surface AudioPlayer touches: createBuffer, createBufferSource, destination,
// currentTime, state, suspend/resume, close, onstatechange.

interface StubBuffer {
  duration: number;
  copyToChannel: ReturnType<typeof vi.fn>;
}

interface StubSource {
  buffer: StubBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface StubAudioContext {
  destination: object;
  currentTime: number;
  state: AudioContextState;
  sampleRate: number;
  onstatechange: (() => void) | null;
  createBuffer: ReturnType<typeof vi.fn>;
  createBufferSource: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  __sources: StubSource[];
  __buffers: StubBuffer[];
}

let lastCtx: StubAudioContext | null = null;

function makeAudioContextCtor() {
  return vi.fn().mockImplementation((opts: { sampleRate: number }) => {
    const ctx: StubAudioContext = {
      destination: {},
      currentTime: 0,
      state: 'running',
      sampleRate: opts.sampleRate,
      onstatechange: null,
      __sources: [],
      __buffers: [],
      createBuffer: vi.fn(
        (_channels: number, samples: number, sampleRate: number) => {
          const buf: StubBuffer = {
            duration: samples / sampleRate,
            copyToChannel: vi.fn(),
          };
          ctx.__buffers.push(buf);
          return buf;
        }
      ),
      createBufferSource: vi.fn(() => {
        const src: StubSource = {
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          onended: null,
        };
        ctx.__sources.push(src);
        return src;
      }),
      suspend: vi.fn().mockImplementation(() => {
        ctx.state = 'suspended';
        if (ctx.onstatechange) ctx.onstatechange();
        return Promise.resolve();
      }),
      resume: vi.fn().mockImplementation(() => {
        ctx.state = 'running';
        if (ctx.onstatechange) ctx.onstatechange();
        return Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    lastCtx = ctx;
    return ctx;
  });
}

// --- electronAPI mock -------------------------------------------------------
type EventCb<T> = (e: T) => void;

interface ApiMock {
  history: { readWav: ReturnType<typeof vi.fn> };
  onTtsChunk: ReturnType<typeof vi.fn>;
  onTtsDone: ReturnType<typeof vi.fn>;
  onTtsError: ReturnType<typeof vi.fn>;
  __chunkSubs: EventCb<TtsChunkEvent>[];
  __doneSubs: EventCb<TtsDoneEvent>[];
  __errorSubs: EventCb<TtsErrorEvent>[];
}

function installApi(): ApiMock {
  const chunkSubs: EventCb<TtsChunkEvent>[] = [];
  const doneSubs: EventCb<TtsDoneEvent>[] = [];
  const errorSubs: EventCb<TtsErrorEvent>[] = [];
  const api: ApiMock = {
    history: { readWav: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])) },
    onTtsChunk: vi.fn((cb: EventCb<TtsChunkEvent>) => {
      chunkSubs.push(cb);
      return () => {
        const i = chunkSubs.indexOf(cb);
        if (i >= 0) chunkSubs.splice(i, 1);
      };
    }),
    onTtsDone: vi.fn((cb: EventCb<TtsDoneEvent>) => {
      doneSubs.push(cb);
      return () => {
        const i = doneSubs.indexOf(cb);
        if (i >= 0) doneSubs.splice(i, 1);
      };
    }),
    onTtsError: vi.fn((cb: EventCb<TtsErrorEvent>) => {
      errorSubs.push(cb);
      return () => {
        const i = errorSubs.indexOf(cb);
        if (i >= 0) errorSubs.splice(i, 1);
      };
    }),
    __chunkSubs: chunkSubs,
    __doneSubs: doneSubs,
    __errorSubs: errorSubs,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.window) g.window.electronAPI = api;
  g.electronAPI = api;
  return api;
}

let originalAudioCtx: unknown;
let audioContextSpy: MockInstance<
  (opts: { sampleRate: number }) => StubAudioContext
>;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  originalAudioCtx = w.AudioContext;
  audioContextSpy = makeAudioContextCtor() as unknown as MockInstance<
    (opts: { sampleRate: number }) => StubAudioContext
  >;
  w.AudioContext = audioContextSpy;
  // requestAnimationFrame in happy-dom returns 0 immediately; that's fine.
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(0), 0) as unknown as number;
    w.cancelAnimationFrame = (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
  lastCtx = null;
});

afterEach(() => {
  cleanup();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  w.AudioContext = originalAudioCtx;
});

function makePcmEvent(
  requestId: string,
  chunkIndex: number,
  totalChunks: number,
  sampleCount = 4
): TtsChunkEvent {
  // sampleCount Float32 samples → sampleCount * 4 bytes
  const ab = new ArrayBuffer(sampleCount * 4);
  const f32 = new Float32Array(ab);
  for (let i = 0; i < sampleCount; i++) f32[i] = (i + 1) * 0.1;
  const u8 = new Uint8Array(ab);
  return {
    requestId,
    chunkIndex,
    totalChunks,
    sampleRate: 24000,
    pcm: u8,
  };
}

describe('AudioPlayer (streaming)', () => {
  it('creates an AudioContext and schedules buffer playback for chunks', async () => {
    installApi();
    const onStreamDone = vi.fn();

    const { rerender } = render(
      <AudioPlayer
        historyItemId={null}
        streamingSource={{
          requestId: 'req-1',
          sampleRate: 24000,
          totalChunks: 2,
        }}
        onStreamDone={onStreamDone}
      />
    );

    // AudioContext should be lazily created with the correct sample rate.
    expect(audioContextSpy).toHaveBeenCalledTimes(1);
    expect(audioContextSpy).toHaveBeenCalledWith({ sampleRate: 24000 });
    expect(lastCtx).not.toBeNull();
    const ctx = lastCtx!;

    // Drive a chunk event through the subscribed listener.
    const api = (globalThis as unknown as { electronAPI: ApiMock })
      .electronAPI;
    expect(api.__chunkSubs.length).toBe(1);

    await act(async () => {
      api.__chunkSubs[0](makePcmEvent('req-1', 0, 2, 8));
    });

    // createBuffer should have been called for the chunk; createBufferSource
    // wired & start scheduled.
    expect(ctx.createBuffer).toHaveBeenCalledTimes(1);
    expect(ctx.createBuffer).toHaveBeenCalledWith(1, 8, 24000);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    const src = ctx.__sources[0];
    expect(src.connect).toHaveBeenCalledWith(ctx.destination);
    expect(src.start).toHaveBeenCalledTimes(1);
    // First chunk gets seeded with a 50ms lead time.
    const firstStartAt = src.start.mock.calls[0][0] as number;
    expect(firstStartAt).toBeCloseTo(0.05, 5);
    // Buffer received the PCM samples.
    expect(ctx.__buffers[0].copyToChannel).toHaveBeenCalledTimes(1);

    // Send a chunk for a different requestId — should be ignored.
    await act(async () => {
      api.__chunkSubs[0](makePcmEvent('other', 1, 2, 4));
    });
    expect(ctx.createBuffer).toHaveBeenCalledTimes(1);

    // Send the second matching chunk; nextStartTime should advance by
    // (firstBuffer.duration + 0.15s gap).
    await act(async () => {
      api.__chunkSubs[0](makePcmEvent('req-1', 1, 2, 8));
    });
    expect(ctx.createBuffer).toHaveBeenCalledTimes(2);
    const src2 = ctx.__sources[1];
    const secondStartAt = src2.start.mock.calls[0][0] as number;
    const firstBufDur = 8 / 24000;
    expect(secondStartAt).toBeCloseTo(firstStartAt + firstBufDur + 0.15, 5);

    // Fire `tts:done`; onStreamDone must NOT yet fire — streaming playback
    // hasn't actually finished. It must wait for the final buffer source to
    // end so the AudioContext isn't torn down mid-playback.
    const item: HistoryItem = {
      id: 'item-1',
      createdAt: '2026-04-15T00:00:00Z',
      text: 'hi',
      voice: 'af_heart',
      speed: 1,
      sampleCount: 16,
      durationMs: 666,
      wavFilename: 'item-1.wav',
      previewText: 'hi',
    };
    await act(async () => {
      api.__doneSubs[0]({
        requestId: 'req-1',
        item,
        wavPath: '/tmp/item-1.wav',
        partial: false,
      });
    });
    expect(onStreamDone).not.toHaveBeenCalled();

    // Simulate the final source finishing playback — that's the handoff
    // moment. Firing a non-final source's onended first should be a no-op.
    await act(async () => {
      ctx.__sources[0].onended?.();
    });
    expect(onStreamDone).not.toHaveBeenCalled();
    await act(async () => {
      ctx.__sources[1].onended?.();
    });
    expect(onStreamDone).toHaveBeenCalledTimes(1);
    expect(onStreamDone).toHaveBeenCalledWith(item);

    // Cleanup: switching to a static historyItemId tears down the context.
    rerender(
      <AudioPlayer
        historyItemId="item-1"
        streamingSource={undefined}
        onStreamDone={onStreamDone}
      />
    );
    expect(ctx.close).toHaveBeenCalled();
  });

  it('fires onStreamDone immediately when tts:done arrives after final source already ended (race case)', async () => {
    installApi();
    const onStreamDone = vi.fn();

    render(
      <AudioPlayer
        historyItemId={null}
        streamingSource={{
          requestId: 'req-2',
          sampleRate: 24000,
          totalChunks: 2,
        }}
        onStreamDone={onStreamDone}
      />
    );

    const ctx = lastCtx!;
    const api = (globalThis as unknown as { electronAPI: ApiMock })
      .electronAPI;

    // Schedule two chunks.
    await act(async () => {
      api.__chunkSubs[0](makePcmEvent('req-2', 0, 2, 4));
      api.__chunkSubs[0](makePcmEvent('req-2', 1, 2, 4));
    });
    expect(ctx.__sources.length).toBe(2);

    // Both scheduled sources finish playback BEFORE tts:done arrives. On
    // short inputs with fast playback this can race against the main
    // process's persistence step. Neither onended should fire the handoff
    // yet because streamDone isn't set.
    await act(async () => {
      ctx.__sources[0].onended?.();
      ctx.__sources[1].onended?.();
    });
    expect(onStreamDone).not.toHaveBeenCalled();

    // tts:done finally arrives. Because every scheduled source already
    // ended, nothing else will call back into the player — the handoff
    // must fire here.
    const item: HistoryItem = {
      id: 'item-2',
      createdAt: '2026-04-15T00:00:00Z',
      text: 'hi',
      voice: 'af_heart',
      speed: 1,
      sampleCount: 8,
      durationMs: 333,
      wavFilename: 'item-2.wav',
      previewText: 'hi',
    };
    await act(async () => {
      api.__doneSubs[0]({
        requestId: 'req-2',
        item,
        wavPath: '/tmp/item-2.wav',
        partial: false,
      });
    });
    expect(onStreamDone).toHaveBeenCalledTimes(1);
    expect(onStreamDone).toHaveBeenCalledWith(item);
  });
});
