import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AudioPlayer } from '../components/AudioPlayer';
import { SpeedSlider } from '../components/SpeedSlider';
import { VoiceSelector } from '../components/VoiceSelector';
import {
  abortTTS,
  generateTTSStream,
  getAllSettings,
  isIpcError,
  listVoices,
  onTtsChunk,
  onTtsDone,
  onTtsError,
} from '../lib/ipc';
import type {
  AppSettings,
  HistoryItem,
  VoiceInfo,
} from '../lib/types';
import { useAppStore } from '../store/useAppStore';

/** Sample rate the sidecar always emits at. Used as the AudioContext rate. */
const STREAM_SAMPLE_RATE = 24000;
/** Audio-rate heuristic: 150 wpm × ~6 chars/word ≈ 900 chars/minute. */
const CHARS_PER_MINUTE = 900;

type ErrorState =
  | null
  | {
      code: string;
      message: string;
    };

function friendlyError(code: string, fallback: string): string {
  switch (code) {
    case 'server_not_running':
      return 'Server is not running. Start it from the tray or Settings.';
    case 'voice_not_found':
      return 'The selected voice is not available. Pick another voice.';
    case 'text_empty':
      return 'Text is empty.';
    case 'invalid_speed':
      return 'Speed must be between 0.5x and 2.0x.';
    case 'model_not_loaded':
      return 'Model is still loading. Please retry in a few seconds.';
    case 'sidecar_unreachable':
      return 'Cannot reach the sidecar server on the configured port.';
    case 'timeout':
      return 'The request timed out. Try a shorter text or restart the server.';
    default:
      return fallback || 'Generation failed.';
  }
}

/**
 * Format an estimated duration in minutes as `m` (under an hour) or `h:mm`
 * (an hour or more). The input is already-rounded minutes — passes through
 * `Math.max(1, ...)` upstream so we never display "0".
 */
function formatEstimate(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${m.toString().padStart(2, '0')}`;
}

export function GenerateView() {
  const status = useAppStore((s) => s.status);
  // Re-use Text → reads pending prefill from useAppStore (single canonical
  // store; the previously-orphaned `useHistoryStore.consumePrefill` was
  // removed in the IPC contract cleanup). The `nonce` field forces this
  // effect to re-run when the user clicks Re-use Text on the same item
  // twice in a row.
  const pendingGenerate = useAppStore((s) => s.pendingGenerate);
  const consumePendingGenerate = useAppStore((s) => s.consumePendingGenerate);

  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [streamTotalChunks, setStreamTotalChunks] = useState<number | null>(
    null
  );
  const [streamReceivedChunks, setStreamReceivedChunks] = useState(0);
  const [error, setError] = useState<ErrorState>(null);
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const voicesFetchedAtRef = useRef<number>(0);
  const requestIdRef = useRef<string | null>(null);

  const serverRunning = status.state === 'running';
  const charCount = text.length;

  // Keep a ref version of requestId so event handlers can filter without
  // re-subscribing every render.
  useEffect(() => {
    requestIdRef.current = requestId;
  }, [requestId]);

  // Load defaults on mount.
  useEffect(() => {
    let alive = true;
    getAllSettings()
      .then((s: AppSettings) => {
        if (!alive) return;
        setVoice((prev) => prev || s.defaultVoice);
        setSpeed((prev) => (prev === 1.0 ? s.defaultSpeed : prev));
      })
      .catch(() => {
        /* ignore — server-not-running state will suppress generation anyway */
      });
    return () => {
      alive = false;
    };
  }, []);

  // (Re)fetch voices whenever the server enters 'running' for the first time.
  useEffect(() => {
    if (!serverRunning) return;
    const now = Date.now();
    if (now - voicesFetchedAtRef.current < 1000) return; // debounce
    voicesFetchedAtRef.current = now;
    let alive = true;
    listVoices()
      .then((res) => {
        if (!alive) return;
        if (isIpcError(res)) {
          // Surface as a banner so the user knows why the voice list is
          // empty — distinguishes "sidecar outage" from "no voices loaded".
          setError({
            code: res.error,
            message: friendlyError(res.error, res.message ?? 'Could not load voices.'),
          });
          return;
        }
        setVoices(res);
        // Fallback: if selected voice isn't available, pick the first.
        if (res.length > 0 && !res.find((x) => x.id === voice)) {
          setVoice((prev) => prev || res[0].id);
        }
      })
      .catch(() => {
        /* ignore — IPC bridge unavailable is already surfaced elsewhere */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRunning]);

  // Subscribe to streaming events. We filter by the active requestId via the
  // ref so chunk subscriptions don't tear down between chunks.
  useEffect(() => {
    const offChunk = onTtsChunk((evt) => {
      if (evt.requestId !== requestIdRef.current) return;
      if (evt.totalChunks > 0) setStreamTotalChunks(evt.totalChunks);
      setStreamReceivedChunks(evt.chunkIndex + 1);
    });
    const offDone = onTtsDone((evt) => {
      if (evt.requestId !== requestIdRef.current) return;
      // Note: the renderer history store is updated by an app-level
      // `onTtsDone` listener in App.tsx that survives tab unmounts. Here
      // we only handle UI state scoped to this Generate session.
      //
      // Generation is complete and the WAV is persisted, but the streaming
      // audio is usually still playing. Reset only the "generating" UI —
      // keep `requestId` / `streamingSource` alive so AudioPlayer can finish
      // scheduling + playing the tail. The static handoff happens via
      // AudioPlayer's `onStreamDone` callback once playback actually ends.
      setIsGenerating(false);
      setStreamTotalChunks(null);
      setStreamReceivedChunks(0);
    });
    const offErr = onTtsError((evt) => {
      if (evt.requestId !== requestIdRef.current) return;
      // Silent for user-driven aborts; surface everything else.
      if (evt.code === 'aborted') {
        resetStreamingState();
        return;
      }
      setError({
        code: evt.code,
        message: friendlyError(evt.code, evt.message),
      });
      resetStreamingState();
    });
    return () => {
      offChunk();
      offDone();
      offErr();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Consume pending prefill (from HistoryView's "Re-use Text"). The
  // `pendingGenerate.nonce` dependency causes this effect to re-fire even
  // when the user clicks Re-use Text on the same item twice in a row.
  useEffect(() => {
    if (!pendingGenerate) return;
    const p = consumePendingGenerate();
    if (p) {
      setText(p.text);
      if (p.voice) setVoice(p.voice);
    }
    // We intentionally key on `nonce` (not the whole `pendingGenerate`)
    // so that when this effect calls `consumePendingGenerate()` and clears
    // the store, we don't re-run on the resulting `null`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGenerate?.nonce]);

  const resetStreamingState = useCallback(() => {
    setIsGenerating(false);
    setRequestId(null);
    setStreamTotalChunks(null);
    setStreamReceivedChunks(0);
  }, []);

  // Invoked by AudioPlayer after the final streaming source has actually
  // finished playback. At this point we swap the player into static mode
  // (`historyItemId` set, `streamingSource` cleared) so the existing WAV
  // blob drives playback from here on. The item has already been added to
  // the renderer store in the `tts:done` handler above; this callback is
  // purely a UI handoff.
  const handleStreamDone = useCallback(
    (item: HistoryItem) => {
      setLastItemId(item.id);
      const secs = (item.sampleCount / STREAM_SAMPLE_RATE).toFixed(1);
      const partialSuffix = item.partial ? ' · partial' : '';
      setLastLabel(`${item.voice} · ${secs}s${partialSuffix}`);
      // Clear any residual streaming state (in case `tts:done` never fired —
      // e.g., error path reached here). `isGenerating` is typically already
      // false by the time playback finishes.
      resetStreamingState();
    },
    [resetStreamingState]
  );

  const canGenerate = useMemo(() => {
    if (isGenerating) return false;
    if (!serverRunning) return false;
    if (!text.trim()) return false;
    if (!voice) return false;
    return true;
  }, [isGenerating, serverRunning, text, voice]);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setIsGenerating(true);
    setError(null);
    setStreamTotalChunks(null);
    setStreamReceivedChunks(0);
    try {
      const res = await generateTTSStream({ text, voice, speed });
      if (isIpcError(res)) {
        setError({
          code: res.error,
          message: friendlyError(res.error, res.message ?? ''),
        });
        // Revert only what this call itself set. Don't touch `requestId`
        // or `lastItemId`: a prior stream may still be in its tail
        // playback phase, and a prior static item may still be on
        // screen — a failed new start shouldn't destroy either.
        setIsGenerating(false);
        return;
      }
      // Success: new stream takes over. Drop any completed static result
      // and install the new requestId — AudioPlayer's effect tears down
      // any in-progress prior streaming context as the id changes.
      setLastItemId(null);
      setRequestId(res.requestId);
    } catch (err) {
      setError({
        code: 'ipc_failed',
        message: err instanceof Error ? err.message : 'Unexpected error.',
      });
      setIsGenerating(false);
    }
  }, [canGenerate, speed, text, voice]);

  const handleStop = useCallback(async () => {
    const rid = requestIdRef.current;
    if (!rid) return;
    try {
      await abortTTS(rid);
    } catch {
      // Even if the abort RPC fails, free up the UI — the renderer can't
      // recover the generation anyway.
      resetStreamingState();
    }
  }, [resetStreamingState]);

  // Keyboard: Cmd+. or Escape aborts the active stream.
  useEffect(() => {
    if (!isGenerating) return;
    const onKey = (e: KeyboardEvent) => {
      const isCmdPeriod = e.key === '.' && (e.metaKey || e.ctrlKey);
      if (e.key === 'Escape' || isCmdPeriod) {
        e.preventDefault();
        void handleStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleStop, isGenerating]);

  const progressLabel = useMemo(() => {
    if (!isGenerating) return null;
    if (streamTotalChunks && streamReceivedChunks > 0) {
      return `Chunk ${streamReceivedChunks} of ${streamTotalChunks}\u2026`;
    }
    return 'Generating\u2026';
  }, [isGenerating, streamReceivedChunks, streamTotalChunks]);

  const estimateMinutes = useMemo(
    () => Math.max(1, Math.round(charCount / CHARS_PER_MINUTE)),
    [charCount]
  );

  const streamingSource = useMemo(() => {
    if (!requestId) return undefined;
    return {
      requestId,
      sampleRate: STREAM_SAMPLE_RATE,
      totalChunks: streamTotalChunks,
    };
  }, [requestId, streamTotalChunks]);

  const showAudioPlayer = !!streamingSource || (!!lastItemId && !isGenerating);

  return (
    <section className="view generate-view">
      <h2>Generate</h2>

      {!serverRunning && (
        <div className="banner banner-warn">
          Server is {status.state}. Start it from the tray to enable generation.
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error.message}</span>
          <button
            type="button"
            className="banner-close"
            onClick={() => setError(null)}
            aria-label="Dismiss"
          >
            {'\u00D7'}
          </button>
        </div>
      )}

      <label className="field-label" htmlFor="tts-text">
        Text to speak
      </label>
      <textarea
        id="tts-text"
        className="tts-textarea"
        placeholder={'Type or paste text to synthesize\u2026'}
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={isGenerating}
      />
      {charCount > 0 && (
        <span className="text-meta" aria-live="polite">
          ~<span className="text-meta-value">{formatEstimate(estimateMinutes)}</span> of audio
        </span>
      )}

      <div className="controls-row">
        <div className="control-voice">
          <label className="field-label">Voice</label>
          <VoiceSelector
            value={voice}
            voices={voices}
            onChange={setVoice}
            disabled={isGenerating}
          />
        </div>
        <div className="control-speed">
          <SpeedSlider value={speed} onChange={setSpeed} disabled={isGenerating} />
        </div>
      </div>

      <div className="generate-row">
        {isGenerating ? (
          <button
            type="button"
            className="btn-generate btn-danger"
            onClick={handleStop}
            aria-busy
            aria-live="polite"
          >
            <svg
              viewBox="0 0 12 12"
              width="12"
              height="12"
              aria-hidden
              focusable="false"
            >
              <rect x="3" y="3" width="6" height="6" fill="currentColor" />
            </svg>
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn-generate"
            onClick={handleGenerate}
            disabled={!canGenerate}
          >
            <svg
              viewBox="0 0 12 12"
              width="11"
              height="11"
              aria-hidden
              focusable="false"
            >
              <path d="M3 2l7 4-7 4z" fill="currentColor" />
            </svg>
            <span>Generate</span>
          </button>
        )}
      </div>

      {isGenerating && (
        <div className="progress-row" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          <span className="muted">{progressLabel}</span>
        </div>
      )}

      {showAudioPlayer && (
        <div className="audio-wrap">
          <AudioPlayer
            historyItemId={lastItemId}
            label={lastLabel ?? undefined}
            streamingSource={streamingSource}
            onStreamDone={handleStreamDone}
            // The user just heard the audio live via the streaming path;
            // don't auto-replay the static WAV immediately after handoff.
            autoPlay={false}
          />
        </div>
      )}
    </section>
  );
}
