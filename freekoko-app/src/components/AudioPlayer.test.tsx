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
  /**
   * Test helper: advance the simulated audio-context clock. While suspended
   * this is a no-op, matching the real Web Audio semantics where
   * `currentTime` freezes under `suspend()`. The AudioPlayer relies on this
   * invariant so `currentTime = ctx.currentTime - startedAt` is correct in
   * both running and paused states.
   */
  __advanceTime: (dt: number) => void;
}

let lastCtx: StubAudioContext | null = null;

function makeAudioContextCtor() {
  return vi.fn().mockImplementation((opts: { sampleRate: number }) => {
    // Backing state for the `currentTime` getter. Tests drive progression
    // via `__advanceTime`; while `suspended` is true, advances are
    // silently dropped so `currentTime` appears frozen — matching the
    // real Web Audio behavior that AudioPlayer depends on.
    let advanced = 0;
    let suspended = false;

    const ctx = {
      destination: {},
      state: 'running' as AudioContextState,
      sampleRate: opts.sampleRate,
      onstatechange: null as (() => void) | null,
      __sources: [] as StubSource[],
      __buffers: [] as StubBuffer[],
      __advanceTime: (dt: number) => {
        if (!suspended) advanced += dt;
      },
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
      // suspend/resume are idempotent on the real AudioContext — calling
      // suspend() twice or resume() twice returns a resolved promise and
      // performs no additional side-effects. We preserve that here so the
      // idempotency tests can assert no double-fire on statechange and no
      // unintended clock manipulation.
      suspend: vi.fn().mockImplementation(() => {
        if (suspended) return Promise.resolve();
        suspended = true;
        ctx.state = 'suspended';
        if (ctx.onstatechange) ctx.onstatechange();
        return Promise.resolve();
      }),
      resume: vi.fn().mockImplementation(() => {
        if (!suspended) return Promise.resolve();
        suspended = false;
        ctx.state = 'running';
        if (ctx.onstatechange) ctx.onstatechange();
        return Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as StubAudioContext;
    Object.defineProperty(ctx, 'currentTime', {
      configurable: true,
      get: () => advanced,
    });
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
    history: {
      readWav: vi.fn().mockResolvedValue({
        ok: true,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    },
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

  // --- AudioContext suspend/resume invariants -----------------------------
  //
  // Root CLAUDE.md contract: play/pause uses AudioContext.suspend()/resume()
  // because ctx.currentTime freezes while suspended, so
  // `currentTime = ctx.currentTime - startedAt` stays correct in both
  // states without wall-clock bookkeeping. These tests lock that in.

  it('tracks progress correctly across multiple suspend/resume cycles', async () => {
    installApi();

    render(
      <AudioPlayer
        historyItemId={null}
        streamingSource={{
          requestId: 'cycle-1',
          sampleRate: 24000,
          totalChunks: 1,
        }}
      />
    );

    const ctx = lastCtx!;
    const api = (globalThis as unknown as { electronAPI: ApiMock })
      .electronAPI;

    // Seed a chunk so `startedAtRef` gets set. With currentTime=0 at seed
    // time, startedAt = 0 + FIRST_CHUNK_LEAD_SECONDS = 0.05.
    await act(async () => {
      api.__chunkSubs[0](makePcmEvent('cycle-1', 0, 1, 24));
    });
    const firstSrc = ctx.__sources[0];
    const startedAt = firstSrc.start.mock.calls[0][0] as number;
    expect(startedAt).toBeCloseTo(0.05, 5);

    // --- Cycle 1: play 0.30s → pause → (frozen) → resume --------------
    await act(async () => {
      ctx.__advanceTime(0.3);
    });
    // While running: elapsed = currentTime - startedAt = 0.3 + 0.05 - 0.05.
    // Actually: currentTime=0.3 (we advanced from 0 by 0.3), startedAt=0.05
    // → elapsed = 0.25. That matches "0.25s of audio played since start".
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.25, 5);

    await act(async () => {
      await ctx.suspend();
    });
    expect(ctx.state).toBe('suspended');
    const pausedAt1 = ctx.currentTime;
    expect(pausedAt1 - startedAt).toBeCloseTo(0.25, 5);

    // Advance while suspended — currentTime must stay frozen.
    await act(async () => {
      ctx.__advanceTime(10); // would be huge wall-clock gap, audio sees 0
    });
    expect(ctx.currentTime).toBe(pausedAt1);
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.25, 5);

    await act(async () => {
      await ctx.resume();
    });
    expect(ctx.state).toBe('running');
    // After resume, reading currentTime again continues from the paused
    // value — the 10s suspended-gap did NOT get injected.
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.25, 5);

    // --- Cycle 2: play 0.20s more → pause → resume --------------------
    await act(async () => {
      ctx.__advanceTime(0.2);
    });
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.45, 5);

    await act(async () => {
      await ctx.suspend();
    });
    await act(async () => {
      ctx.__advanceTime(5);
    });
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.45, 5);
    await act(async () => {
      await ctx.resume();
    });
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.45, 5);

    // --- Cycle 3: play 0.05s more → pause → resume --------------------
    await act(async () => {
      ctx.__advanceTime(0.05);
    });
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.5, 5);

    await act(async () => {
      await ctx.suspend();
    });
    await act(async () => {
      ctx.__advanceTime(100);
    });
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.5, 5);
    await act(async () => {
      await ctx.resume();
    });
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.5, 5);

    // Final check: one more play burst to prove the clock is still moving
    // correctly after three full suspend/resume cycles.
    await act(async () => {
      ctx.__advanceTime(0.1);
    });
    expect(ctx.currentTime - startedAt).toBeCloseTo(0.6, 5);
  });

  it('keeps scheduled-ahead buffer starts aligned when suspended mid-playback', async () => {
    installApi();

    render(
      <AudioPlayer
        historyItemId={null}
        streamingSource={{
          requestId: 'sched-1',
          sampleRate: 24000,
          totalChunks: 3,
        }}
      />
    );

    const ctx = lastCtx!;
    const api = (globalThis as unknown as { electronAPI: ApiMock })
      .electronAPI;

    // Schedule three chunks of 24 samples @ 24000 Hz → 0.001s each.
    // With INTER_CHUNK_SILENCE_SECONDS = 0.15, successive start times are
    // seeded on top of nextStartTime so they share the AudioContext clock,
    // not wall-clock. Critically: when we later suspend() and "wait", the
    // queued starts must NOT slide — they're in AudioContext time and
    // currentTime is frozen.
    await act(async () => {
      api.__chunkSubs[0](makePcmEvent('sched-1', 0, 3, 24));
      api.__chunkSubs[0](makePcmEvent('sched-1', 1, 3, 24));
      api.__chunkSubs[0](makePcmEvent('sched-1', 2, 3, 24));
    });
    expect(ctx.__sources.length).toBe(3);
    const start0 = ctx.__sources[0].start.mock.calls[0][0] as number;
    const start1 = ctx.__sources[1].start.mock.calls[0][0] as number;
    const start2 = ctx.__sources[2].start.mock.calls[0][0] as number;
    const bufDur = 24 / 24000;
    expect(start0).toBeCloseTo(0.05, 5);
    expect(start1).toBeCloseTo(start0 + bufDur + 0.15, 5);
    expect(start2).toBeCloseTo(start1 + bufDur + 0.15, 5);

    // Play past the first chunk but before the second one's scheduled
    // start. Then suspend with src1 and src2 still queued in the future.
    await act(async () => {
      ctx.__advanceTime(0.1); // currentTime = 0.10, first src start = 0.05
    });
    expect(ctx.currentTime).toBeCloseTo(0.1, 5);
    expect(start1).toBeGreaterThan(ctx.currentTime); // not yet played

    await act(async () => {
      await ctx.suspend();
    });
    // Suspended: simulate a long wall-clock pause.
    await act(async () => {
      ctx.__advanceTime(30);
    });
    expect(ctx.currentTime).toBeCloseTo(0.1, 5);

    // Resume — the queued sources' scheduled start times (captured at
    // schedule time via src.start(startAt)) were NOT retroactively
    // shifted; they remain pinned in AudioContext-time. Assert the call
    // record is untouched.
    await act(async () => {
      await ctx.resume();
    });
    const start1After = ctx.__sources[1].start.mock.calls[0][0] as number;
    const start2After = ctx.__sources[2].start.mock.calls[0][0] as number;
    expect(start1After).toBeCloseTo(start1, 5);
    expect(start2After).toBeCloseTo(start2, 5);
    // And the wall-clock-relative "misalignment" that a naive player
    // would have accumulated (30s) is simply absent from ctx time.
    expect(ctx.currentTime - start0).toBeCloseTo(0.05, 5);
  });

  it('treats redundant suspend()/resume() calls as idempotent', async () => {
    installApi();

    render(
      <AudioPlayer
        historyItemId={null}
        streamingSource={{
          requestId: 'idem-1',
          sampleRate: 24000,
          totalChunks: 1,
        }}
      />
    );

    const ctx = lastCtx!;
    const api = (globalThis as unknown as { electronAPI: ApiMock })
      .electronAPI;

    await act(async () => {
      api.__chunkSubs[0](makePcmEvent('idem-1', 0, 1, 24));
    });

    let stateChanges = 0;
    const prevHandler = ctx.onstatechange;
    ctx.onstatechange = () => {
      stateChanges += 1;
      if (prevHandler) prevHandler();
    };

    // Advance a bit so there's a non-zero reading to compare against.
    await act(async () => {
      ctx.__advanceTime(0.2);
    });
    const timeBefore = ctx.currentTime;

    // Two suspends in a row: only the first should flip state.
    await act(async () => {
      await ctx.suspend();
      await ctx.suspend();
    });
    expect(ctx.state).toBe('suspended');
    expect(stateChanges).toBe(1);
    // Advancing while suspended is still a no-op; a second redundant
    // suspend shouldn't "double-freeze" anything weird.
    await act(async () => {
      ctx.__advanceTime(5);
    });
    expect(ctx.currentTime).toBeCloseTo(timeBefore, 5);

    // Two resumes in a row: only the first should flip state.
    await act(async () => {
      await ctx.resume();
      await ctx.resume();
    });
    expect(ctx.state).toBe('running');
    expect(stateChanges).toBe(2);

    // Clock still functions post-double-resume.
    await act(async () => {
      ctx.__advanceTime(0.1);
    });
    expect(ctx.currentTime).toBeCloseTo(timeBefore + 0.1, 5);
  });
});
