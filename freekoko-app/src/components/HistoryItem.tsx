import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryItem as HistoryItemType } from '../lib/types';
import {
  deleteHistory,
  readHistoryWav,
  saveHistoryWav,
} from '../lib/ipc';
import { useAppStore } from '../store/useAppStore';
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
  parseVoiceId,
  truncate,
} from '../lib/format';

export interface HistoryItemProps {
  item: HistoryItemType;
  onDeleted?: (id: string) => void;
  /** Test-only hook for deterministic "now" in relative time output. */
  now?: Date;
  /** Test seam: override window.confirm. */
  confirmFn?: (message: string) => boolean;
}

export function HistoryItem({
  item,
  onDeleted,
  now,
  confirmFn,
}: HistoryItemProps) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reuseInGenerate = useAppStore((s) => s.reuseInGenerate);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    urlRef.current = audioUrl;
  }, [audioUrl]);

  // Revoke blob URL on unmount to avoid leaking memory for every item
  // that was ever played.
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const voice = parseVoiceId(item.voice);
  const relative = formatRelativeTime(item.createdAt, now);
  const absolute = formatAbsoluteTime(item.createdAt);
  const previewText = item.previewText ?? item.text ?? '';

  const handleLoadAudio = useCallback(async () => {
    if (audioUrl || loading) return;
    setLoading(true);
    setError(null);
    try {
      const bytes = await readHistoryWav(item.id);
      if (!bytes) {
        setError('Could not load audio');
        return;
      }
      // Copy into a plain ArrayBuffer to sidestep the strict DOM typing
      // that rejects Uint8Array<SharedArrayBuffer> for BlobPart.
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const blob = new Blob([buf], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [audioUrl, item.id, loading]);

  const handleReuse = useCallback(() => {
    reuseInGenerate({ text: item.text ?? previewText, voice: item.voice });
  }, [item.text, item.voice, previewText, reuseInGenerate]);

  const handleSave = useCallback(async () => {
    const res = await saveHistoryWav(item.id);
    if (!res.ok && !res.canceled) {
      setError('Save failed');
    }
  }, [item.id]);

  const handleDelete = useCallback(async () => {
    const confirm = confirmFn ?? ((m: string) => window.confirm(m));
    const ok = confirm('Delete this generation? This cannot be undone.');
    if (!ok) return;
    const deleted = await deleteHistory(item.id);
    if (deleted) {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
        setAudioUrl(null);
      }
      onDeleted?.(item.id);
    } else {
      setError('Delete failed');
    }
  }, [confirmFn, item.id, onDeleted]);

  return (
    <article className="history-item" data-testid="history-item" data-id={item.id}>
      <header className="history-item-header">
        <span className="history-item-ts" title={absolute}>
          {relative}
        </span>
        <span className="history-item-voice-badge" aria-label={`Voice: ${voice.displayName}, ${voice.languageName}, ${voice.gender}`}>
          <span aria-hidden="true">{voice.flag}</span>{' '}
          {voice.displayName} ({voice.gender.charAt(0)}, A)
        </span>
        <span className="history-item-duration muted">
          {formatDuration(item.durationMs)}
        </span>
      </header>
      <p className="history-item-preview" title={item.text ?? previewText}>
        “{truncate(previewText, 120)}”
      </p>
      <div className="history-item-actions">
        {audioUrl ? (
          <audio
            controls
            src={audioUrl}
            className="history-item-audio"
            data-testid="history-item-audio"
            autoPlay
          />
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleLoadAudio}
            disabled={loading}
            data-testid="history-item-play"
          >
            {loading ? 'Loading…' : '▶ Play'}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={handleReuse}
          data-testid="history-item-reuse"
        >
          ↩ Re-use Text
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleSave}
          data-testid="history-item-save"
        >
          ↓ Save As…
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={handleDelete}
          data-testid="history-item-delete"
          aria-label="Delete"
        >
          ✕
        </button>
      </div>
      {error && <p className="history-item-error">{error}</p>}
    </article>
  );
}
