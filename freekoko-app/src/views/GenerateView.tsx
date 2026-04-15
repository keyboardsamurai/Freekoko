import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AudioPlayer } from '../components/AudioPlayer';
import { SpeedSlider } from '../components/SpeedSlider';
import { VoiceSelector } from '../components/VoiceSelector';
import {
  generateTTS,
  getAllSettings,
  isIpcError,
  listVoices,
  onTtsProgress,
} from '../lib/ipc';
import type {
  AppSettings,
  TtsProgress,
  TtsProgressEvent,
  VoiceInfo,
} from '../lib/types';
import { useAppStore } from '../store/useAppStore';
import { useHistoryStore } from '../store/useHistoryStore';

const MAX_CHARS = 8000;
const WARN_CHARS = 7500;

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
    case 'text_too_long':
      return `Text exceeds ${MAX_CHARS} characters.`;
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

export function GenerateView() {
  const status = useAppStore((s) => s.status);
  const addHistoryItem = useHistoryStore((s) => s.add);
  const consumePrefill = useHistoryStore((s) => s.consumePrefill);

  const [text, setText] = useState('');
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<
    TtsProgressEvent | TtsProgress | null
  >(null);
  const [error, setError] = useState<ErrorState>(null);
  const [lastItemId, setLastItemId] = useState<string | null>(null);
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const voicesFetchedAtRef = useRef<number>(0);

  const serverRunning = status.state === 'running';
  const charCount = text.length;
  const charOver = charCount > MAX_CHARS;
  const charWarn = charCount >= WARN_CHARS;

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
      .then((v) => {
        if (!alive) return;
        setVoices(v);
        // Fallback: if selected voice isn't available, pick the first.
        if (v.length > 0 && !v.find((x) => x.id === voice)) {
          setVoice((prev) => prev || v[0].id);
        }
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRunning]);

  // Subscribe to on:tts-progress events.
  useEffect(() => {
    const off = onTtsProgress((p) => {
      setProgress(p);
    });
    return () => off();
  }, []);

  // Consume pending prefill (from HistoryView "Re-use Text").
  useEffect(() => {
    const p = consumePrefill();
    if (p) {
      setText(p.text);
      if (p.voice) setVoice(p.voice);
    }
  }, [consumePrefill]);

  const canGenerate = useMemo(() => {
    if (isGenerating) return false;
    if (!serverRunning) return false;
    if (!text.trim()) return false;
    if (charOver) return false;
    if (!voice) return false;
    return true;
  }, [isGenerating, serverRunning, text, charOver, voice]);

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return;
    setIsGenerating(true);
    setError(null);
    setProgress({ phase: 'start', textLength: text.length });
    try {
      const res = await generateTTS({ text, voice, speed });
      if (isIpcError(res)) {
        setError({
          code: res.error,
          message: friendlyError(res.error, res.message ?? ''),
        });
        return;
      }
      addHistoryItem(res.item);
      setLastItemId(res.item.id);
      const secs = (res.item.sampleCount / 24000).toFixed(1);
      setLastLabel(`${res.item.voice} · ${secs}s`);
    } catch (err) {
      setError({
        code: 'ipc_failed',
        message: err instanceof Error ? err.message : 'Unexpected error.',
      });
    } finally {
      setIsGenerating(false);
      setProgress(null);
    }
  }, [addHistoryItem, canGenerate, speed, text, voice]);

  const progressLabel = useMemo(() => {
    if (!isGenerating) return null;
    if (!progress) return 'Generating\u2026';
    // Support both the richer TtsProgressEvent and the legacy TtsProgress.
    const evt = progress as TtsProgressEvent & Partial<TtsProgress>;
    if (evt.phase === 'chunk' && evt.chunkIndex != null && evt.totalChunks != null) {
      return `Generating chunk ${evt.chunkIndex + 1} of ${evt.totalChunks}\u2026`;
    }
    if (typeof (progress as TtsProgress).chunkIndex === 'number') {
      const legacy = progress as TtsProgress;
      return `Generating chunk ${legacy.chunkIndex + 1} of ${legacy.totalChunks}\u2026`;
    }
    return 'Generating\u2026';
  }, [isGenerating, progress]);

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
      <div
        className={`char-counter${charOver ? ' char-over' : ''}${
          charWarn && !charOver ? ' char-warn' : ''
        }`}
      >
        {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()} characters
      </div>

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
        <button
          type="button"
          className="btn-generate"
          onClick={handleGenerate}
          disabled={!canGenerate}
        >
          {isGenerating ? progressLabel : '\u25B6  Generate Speech'}
        </button>
      </div>

      {isGenerating && (
        <div className="progress-row">
          <span className="spinner" aria-hidden />
          <span className="muted">{progressLabel}</span>
        </div>
      )}

      {lastItemId && !isGenerating && (
        <div className="audio-wrap">
          <AudioPlayer historyItemId={lastItemId} label={lastLabel ?? undefined} />
        </div>
      )}
    </section>
  );
}
