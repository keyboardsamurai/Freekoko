import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { readHistoryWav, saveHistoryWav } from '../lib/ipc';
import './AudioPlayer.css';

interface Props {
  historyItemId: string | null;
  /** Optional label under the player (e.g., voice + duration). */
  label?: string;
  /** Auto-play when a new item is loaded. */
  autoPlay?: boolean;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function AudioPlayer({ historyItemId, label, autoPlay = true }: Props) {
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

  // --- Load audio bytes --------------------------------------------------
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
    const a = audioRef.current;
    if (!a) return;
    if (a.paused || a.ended) {
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      a.pause();
    }
  }, []);

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
      if (!url) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDragging(true);
      seekToRatio(ratioFromPointer(e.clientX));
    },
    [ratioFromPointer, seekToRatio, url],
  );

  const handleScrubPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      seekToRatio(ratioFromPointer(e.clientX));
    },
    [dragging, ratioFromPointer, seekToRatio],
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
    [togglePlay, url],
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

  if (!historyItemId) return null;

  const progressRatio =
    duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  const progressPct = `${progressRatio * 100}%`;
  const disabled = !url;

  return (
    <div className="audio-player">
      {loading && <div className="muted">Loading audio…</div>}
      {error && <div className="banner banner-error">{error}</div>}
      {url && (
        <>
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
          <div className="audio-transport">
            <button
              type="button"
              className="audio-playpause"
              onClick={togglePlay}
              disabled={disabled}
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
              tabIndex={disabled ? -1 : 0}
              aria-label="Seek"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, Math.round(duration))}
              aria-valuenow={Math.round(currentTime)}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
              aria-disabled={disabled || undefined}
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
        </>
      )}
    </div>
  );
}
