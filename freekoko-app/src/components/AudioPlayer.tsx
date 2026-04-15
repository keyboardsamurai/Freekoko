import { useEffect, useRef, useState } from 'react';
import { readHistoryWav, saveHistoryWav } from '../lib/ipc';

interface Props {
  historyItemId: string | null;
  /** Optional label under the player (e.g., voice + duration). */
  label?: string;
  /** Auto-play when a new item is loaded. */
  autoPlay?: boolean;
}

export function AudioPlayer({ historyItemId, label, autoPlay = true }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  // Autoplay when url changes. We trigger .play() explicitly because
  // changing <audio src=...> at runtime does not always restart playback.
  useEffect(() => {
    if (url && autoPlay && audioRef.current) {
      audioRef.current.currentTime = 0;
      const p = audioRef.current.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }, [url, autoPlay]);

  async function handleSave() {
    if (!historyItemId) return;
    setSaving(true);
    try {
      await saveHistoryWav(historyItemId);
    } finally {
      setSaving(false);
    }
  }

  if (!historyItemId) return null;

  return (
    <div className="audio-player">
      {loading && <div className="muted">Loading audio…</div>}
      {error && <div className="banner banner-error">{error}</div>}
      {url && (
        <>
          <audio
            ref={audioRef}
            src={url}
            controls
            preload="auto"
            className="audio-el"
          />
          <div className="audio-actions">
            {label && <span className="muted">{label}</span>}
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
