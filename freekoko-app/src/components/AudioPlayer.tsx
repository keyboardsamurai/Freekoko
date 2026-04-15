import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  onTtsChunk,
  onTtsDone,
  onTtsError,
  readHistoryWav,
  saveHistoryWav,
} from '../lib/ipc';
import type { HistoryItem } from '../lib/types';
import './AudioPlayer.css';

interface StreamingSource {
  requestId: string;
  /** Optimistic sample rate; the real value comes in with each chunk. */
  sampleRate: number;
  totalChunks: number | null;
}

interface Props {
  historyItemId: string | null;
  /** Optional label under the player (e.g., voice + duration). */
  label?: string;
  /** Auto-play when a new item is loaded. */
  autoPlay?: boolean;
  /**
   * When provided AND `historyItemId` is null, the player enters streaming
   * mode: it lazily creates an `AudioContext`, subscribes to `tts:chunk`
   * events filtered by `requestId`, and schedules each PCM chunk for
   * playback. On `tts:done`, the parent should set `historyItemId` to the
   * returned item's id so the player swaps to static-playback mode.
   */
  streamingSource?: StreamingSource;
  /** Called when the streaming generation completes (either fully or as a partial). */
  onStreamDone?: (item: HistoryItem) => void;
}

/** Inter-chunk silence (in seconds) — must match main-process WAV assembly. */
const INTER_CHUNK_SILENCE_SECONDS = 0.15;
/** Lead time before scheduling the first source, gives the audio thread headroom. */
const FIRST_CHUNK_LEAD_SECONDS = 0.05;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

type AudioContextCtor = typeof AudioContext;
function getAudioContextCtor(): AudioContextCtor | null {
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function AudioPlayer({
  historyItemId,
  label,
  autoPlay = true,
  streamingSource,
  onStreamDone,
}: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Transport state
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [dragging, setDragging] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrubRef = useRef<HTMLDivElement | null>(null);

  // Streaming-mode refs (only meaningful when `streamingSource` is set and
  // `historyItemId` is null).
  const ctxRef = useRef<AudioContext | null>(null);
  const startedAtRef = useRef<number>(0);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const lastSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const streamDoneRef = useRef<boolean>(false);
  const chunksReceivedRef = useRef<number>(0);
  const totalChunksKnownRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  // Handoff coordination: `pendingDoneItemRef` holds the persisted item
  // that tts:done delivered; `finalHandoffFiredRef` guarantees at-most-one
  // onStreamDone call per stream (and suppresses firing during teardown);
  // `endedCountRef` tracks how many scheduled buffer sources have ended,
  // so a late tts:done (arriving after the last source already finished
  // playing — rare but possible) still produces a handoff.
  const pendingDoneItemRef = useRef<HistoryItem | null>(null);
  const finalHandoffFiredRef = useRef<boolean>(false);
  const endedCountRef = useRef<number>(0);
  const onStreamDoneRef = useRef(onStreamDone);
  useEffect(() => {
    onStreamDoneRef.current = onStreamDone;
  }, [onStreamDone]);

  const isStreaming = !!streamingSource && !historyItemId;

  // --- Load audio bytes (static playback) -------------------------------
  useEffect(() => {
    let alive = true;
    let createdUrl: string | null = null;

    if (!historyItemId) {
      setUrl(null);
      return;
    }

    setLoading(true);
    setError(null);
    readHistoryWav(historyItemId)
      .then((bytes) => {
        if (!alive) return;
        if (!bytes) {
          setError('Audio file is missing.');
          setUrl(null);
          return;
        }
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const blob = new Blob([copy], { type: 'audio/wav' });
        createdUrl = URL.createObjectURL(blob);
        setUrl(createdUrl);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Failed to load audio');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [historyItemId]);

  // --- Autoplay on new url -----------------------------------------------
  useEffect(() => {
    if (url && autoPlay && audioRef.current) {
      audioRef.current.currentTime = 0;
      const p = audioRef.current.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }, [url, autoPlay]);

  // --- Streaming mode: AudioContext lifecycle ---------------------------
  useEffect(() => {
    if (!streamingSource || historyItemId) return;
    const Ctor = getAudioContextCtor();
    if (!Ctor) {
      setError('Audio playback is not supported in this environment.');
      return;
    }

    // Reset state for a fresh stream.
    setError(null);
    setIsPlaying(false);
    setDuration(0);
    setCurrentTime(0);
    chunksReceivedRef.current = 0;
    totalChunksKnownRef.current = streamingSource.totalChunks;
    streamDoneRef.current = false;
    startedAtRef.current = 0;
    nextStartTimeRef.current = 0;
    sourcesRef.current = [];
    lastSourceRef.current = null;
    activeRequestIdRef.current = streamingSource.requestId;
    pendingDoneItemRef.current = null;
    finalHandoffFiredRef.current = false;
    endedCountRef.current = 0;

    /**
     * Fires `onStreamDone` exactly once. Called from two sites:
     *  - the final scheduled source's `onended` (normal case)
     *  - the `tts:done` handler, if all scheduled sources have already
     *    ended by the time the main process signals completion (race).
     * Guarded so effect teardown can null out `activeRequestIdRef` to
     * prevent spurious handoffs during unmount.
     */
    const triggerFinalHandoff = () => {
      if (finalHandoffFiredRef.current) return;
      if (activeRequestIdRef.current !== streamingSource.requestId) return;
      const item = pendingDoneItemRef.current;
      if (!item) return;
      finalHandoffFiredRef.current = true;
      onStreamDoneRef.current?.(item);
    };

    const ctx = new Ctor({ sampleRate: streamingSource.sampleRate });
    ctxRef.current = ctx;

    const onState = () => {
      const running = ctx.state === 'running';
      setIsPlaying(running);
      if (running) {
        scheduleRaf();
      }
    };
    ctx.onstatechange = onState;

    // Resume on first user gesture if the context is auto-suspended (Chrome
    // autoplay policies). Electron is usually permissive but this is cheap.
    const resumeOnGesture = () => {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    };
    window.addEventListener('pointerdown', resumeOnGesture, { once: true });
    window.addEventListener('keydown', resumeOnGesture, { once: true });

    const scheduleRaf = () => {
      if (rafRef.current != null) return;
      const tick = () => {
        rafRef.current = null;
        const c = ctxRef.current;
        if (!c) return;
        const elapsed = c.currentTime - startedAtRef.current;
        // Snap to duration when stream is done and final source has played.
        if (streamDoneRef.current) {
          const total = nextStartTimeRef.current - startedAtRef.current;
          if (elapsed >= total) {
            setCurrentTime(total);
            return;
          }
        }
        if (startedAtRef.current > 0) {
          setCurrentTime(Math.max(0, elapsed));
        }
        if (c.state === 'running') {
          rafRef.current = requestAnimationFrame(tick);
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    // Subscribe to stream events.
    const offChunk = onTtsChunk((evt) => {
      if (evt.requestId !== activeRequestIdRef.current) return;
      const c = ctxRef.current;
      if (!c) return;
      try {
        const pcm = new Float32Array(
          evt.pcm.buffer,
          evt.pcm.byteOffset,
          evt.pcm.byteLength / 4
        );
        if (pcm.length === 0) return;
        const buf = c.createBuffer(1, pcm.length, evt.sampleRate);
        // copyToChannel exists on real BaseAudioBuffer; guard for stubs.
        // The view's backing buffer is always a plain ArrayBuffer at the IPC
        // boundary (structured-clone); the cast satisfies strict lib.dom.
        if (typeof (buf as AudioBuffer).copyToChannel === 'function') {
          (buf as AudioBuffer).copyToChannel(
            pcm as Float32Array<ArrayBuffer>,
            0
          );
        }
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(c.destination);
        if (nextStartTimeRef.current === 0) {
          const start = c.currentTime + FIRST_CHUNK_LEAD_SECONDS;
          startedAtRef.current = start;
          nextStartTimeRef.current = start;
        }
        const startAt = nextStartTimeRef.current;
        try {
          src.start(startAt);
        } catch {
          // Some stubs don't implement start(). Swallow for resilience.
        }
        sourcesRef.current.push(src);
        lastSourceRef.current = src;
        nextStartTimeRef.current =
          startAt + buf.duration + INTER_CHUNK_SILENCE_SECONDS;
        chunksReceivedRef.current += 1;
        if (evt.totalChunks > 0) {
          totalChunksKnownRef.current = evt.totalChunks;
        }
        // Every scheduled source reports its end so we can tell when all
        // scheduled PCM has actually played. When the final source ends
        // AFTER `tts:done` has arrived, that's the moment to hand off to
        // static-playback mode.
        src.onended = () => {
          endedCountRef.current += 1;
          if (
            streamDoneRef.current &&
            lastSourceRef.current === src &&
            ctxRef.current
          ) {
            setIsPlaying(false);
            const total =
              nextStartTimeRef.current - startedAtRef.current;
            setCurrentTime(total);
            triggerFinalHandoff();
          }
        };
        // Update the displayed (growing) duration estimate.
        setDuration(nextStartTimeRef.current - startedAtRef.current);
        scheduleRaf();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('AudioPlayer: failed to schedule chunk', err);
      }
    });

    const offDone = onTtsDone((evt) => {
      if (evt.requestId !== activeRequestIdRef.current) return;
      streamDoneRef.current = true;
      pendingDoneItemRef.current = evt.item;
      // Snap to the exact duration once we know sampleCount.
      const sr = evt.item.sampleCount > 0 ? evt.item.sampleCount : 0;
      // sample-rate is constant 24000 in our pipeline; prefer streamingSource
      // for an authoritative source.
      const sampleRate = streamingSource.sampleRate || 24000;
      if (sr > 0 && sampleRate > 0) {
        setDuration(sr / sampleRate);
      }
      // Race: if every scheduled source has already fired onended before
      // tts:done arrived (can happen on very short inputs or if persistence
      // lags), trigger the handoff right now — otherwise no `onended` will
      // fire again and we'd strand the player in streaming mode.
      const scheduled = sourcesRef.current.length;
      if (scheduled > 0 && endedCountRef.current >= scheduled) {
        setIsPlaying(false);
        const total = nextStartTimeRef.current - startedAtRef.current;
        setCurrentTime(total);
        triggerFinalHandoff();
      }
    });

    const offErr = onTtsError((evt) => {
      if (evt.requestId !== activeRequestIdRef.current) return;
      if (evt.code === 'aborted') return; // user-driven, silent
      setError(evt.message || 'Streaming generation failed.');
    });

    return () => {
      // Suppress the handoff before stopping sources: `s.stop()` below
      // can synchronously invoke `onended`, which would otherwise race the
      // static-mode transition (e.g., if the parent started a new stream
      // or unmounted).
      finalHandoffFiredRef.current = true;
      activeRequestIdRef.current = null;
      offChunk();
      offDone();
      offErr();
      window.removeEventListener('pointerdown', resumeOnGesture);
      window.removeEventListener('keydown', resumeOnGesture);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // Stop any in-flight buffer sources.
      for (const s of sourcesRef.current) {
        try {
          s.stop();
        } catch {
          /* already stopped or not yet started */
        }
        try {
          s.disconnect();
        } catch {
          /* */
        }
      }
      sourcesRef.current = [];
      lastSourceRef.current = null;
      try {
        ctx.onstatechange = null;
      } catch {
        /* */
      }
      try {
        ctx.close();
      } catch {
        /* already closed */
      }
      ctxRef.current = null;
    };
    // We intentionally key the effect on requestId only — re-running on
    // every prop tick would tear down the AudioContext mid-stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamingSource?.requestId, historyItemId]);

  // --- Save --------------------------------------------------------------
  async function handleSave() {
    if (!historyItemId) return;
    setSaving(true);
    try {
      await saveHistoryWav(historyItemId);
    } finally {
      setSaving(false);
    }
  }

  // --- Transport handlers ------------------------------------------------
  const togglePlay = useCallback(() => {
    if (isStreaming) {
      const c = ctxRef.current;
      if (!c) return;
      if (c.state === 'running') {
        c.suspend().catch(() => {});
      } else {
        c.resume().catch(() => {});
      }
      return;
    }
    const a = audioRef.current;
    if (!a) return;
    if (a.paused || a.ended) {
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      a.pause();
    }
  }, [isStreaming]);

  const seekToRatio = useCallback((ratio: number) => {
    const a = audioRef.current;
    if (!a) return;
    const d = a.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const clamped = Math.min(1, Math.max(0, ratio));
    a.currentTime = clamped * d;
    setCurrentTime(a.currentTime);
  }, []);

  const ratioFromPointer = useCallback(
    (clientX: number): number => {
      const el = scrubRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return 0;
      return (clientX - rect.left) / rect.width;
    },
    [],
  );

  const handleScrubPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!url || isStreaming) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      seekToRatio(ratioFromPointer(e.clientX));
    },
    [isStreaming, ratioFromPointer, seekToRatio, url],
  );

  const handleScrubPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging || isStreaming) return;
      seekToRatio(ratioFromPointer(e.clientX));
    },
    [dragging, isStreaming, ratioFromPointer, seekToRatio],
  );

  const handleScrubPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setDragging(false);
    },
    [],
  );

  const handleScrubKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (isStreaming) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          togglePlay();
        }
        return;
      }
      const a = audioRef.current;
      if (!a || !url) return;
      const step = 5; // seconds
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        a.currentTime = Math.max(0, a.currentTime - step);
        setCurrentTime(a.currentTime);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        a.currentTime = Math.min(a.duration || 0, a.currentTime + step);
        setCurrentTime(a.currentTime);
      } else if (e.key === 'Home') {
        e.preventDefault();
        a.currentTime = 0;
        setCurrentTime(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        if (Number.isFinite(a.duration)) {
          a.currentTime = a.duration;
          setCurrentTime(a.duration);
        }
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        togglePlay();
      }
    },
    [isStreaming, togglePlay, url],
  );

  // --- Audio element events ---------------------------------------------
  const handleLoadedMetadata = () => {
    const a = audioRef.current;
    if (!a) return;
    setDuration(Number.isFinite(a.duration) ? a.duration : 0);
  };
  const handleTimeUpdate = () => {
    const a = audioRef.current;
    if (!a || dragging) return;
    setCurrentTime(a.currentTime);
  };
  const handlePlay = () => setIsPlaying(true);
  const handlePause = () => setIsPlaying(false);
  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(duration);
  };

  // Render guard — neither static nor streaming source available.
  if (!historyItemId && !isStreaming) return null;

  const progressRatio =
    duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const progressPct = `${progressRatio * 100}%`;
  const transportDisabled = isStreaming ? !ctxRef.current : !url;

  return (
    <div className="audio-player">
      {loading && <div className="muted">Loading audio…</div>}
      {error && <div className="banner banner-error">{error}</div>}
      {(url || isStreaming) && (
        <>
          {url && (
            <audio
              ref={audioRef}
              src={url}
              preload="auto"
              className="audio-el"
              onLoadedMetadata={handleLoadedMetadata}
              onDurationChange={handleLoadedMetadata}
              onTimeUpdate={handleTimeUpdate}
              onPlay={handlePlay}
              onPause={handlePause}
              onEnded={handleEnded}
              hidden
            />
          )}
          <div
            className="audio-transport"
            data-streaming={isStreaming ? 'true' : undefined}
          >
            <button
              type="button"
              className="audio-playpause"
              onClick={togglePlay}
              disabled={transportDisabled}
              data-state={isPlaying ? 'playing' : 'paused'}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              aria-pressed={isPlaying}
            >
              {isPlaying ? (
                <svg
                  viewBox="0 0 12 12"
                  width="11"
                  height="11"
                  aria-hidden
                  focusable="false"
                >
                  <rect x="3" y="2.5" width="2" height="7" rx="0.5" fill="currentColor" />
                  <rect x="7" y="2.5" width="2" height="7" rx="0.5" fill="currentColor" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 12 12"
                  width="11"
                  height="11"
                  aria-hidden
                  focusable="false"
                  style={{ marginLeft: 1 }}
                >
                  <path d="M3 2l7 4-7 4z" fill="currentColor" />
                </svg>
              )}
            </button>
            <div
              ref={scrubRef}
              className="audio-scrub"
              role="slider"
              tabIndex={transportDisabled || isStreaming ? -1 : 0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, Math.round(duration))}
              aria-valuenow={Math.round(currentTime)}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
              aria-disabled={transportDisabled || isStreaming || undefined}
              data-dragging={dragging || undefined}
              onPointerDown={handleScrubPointerDown}
              onPointerMove={handleScrubPointerMove}
              onPointerUp={handleScrubPointerUp}
              onPointerCancel={handleScrubPointerUp}
              onKeyDown={handleScrubKeyDown}
            >
              <div className="audio-scrub-track">
                <div
                  className="audio-scrub-fill"
                  style={{ width: progressPct }}
                />
              </div>
              <div
                className="audio-scrub-thumb"
                style={{ left: progressPct }}
              />
            </div>
            <div className="audio-time" aria-hidden>
              <span>{formatTime(currentTime)}</span>
              <span className="audio-time-sep">/</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
          {!isStreaming && (
            <div className="audio-actions">
              {label ? <span className="muted">{label}</span> : <span />}
              <button
                type="button"
                className="btn"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Audio\u2026'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
