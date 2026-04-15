import { useCallback, useEffect, useRef, useState } from 'react';
import { useHistoryStore } from '../store/useHistoryStore';
import { HistoryItem } from '../components/HistoryItem';
import { clearHistory, listHistory } from '../lib/ipc';

const PAGE_SIZE = 50;

export function HistoryView() {
  const items = useHistoryStore((s) => s.items);
  const setItems = useHistoryStore((s) => s.setItems);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listHistory({ limit: PAGE_SIZE, offset: 0 });
      setItems(next);
      setReachedEnd(next.length < PAGE_SIZE);
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }, [setItems]);

  const loadMore = useCallback(async () => {
    if (loadingMore || reachedEnd) return;
    setLoadingMore(true);
    try {
      const next = await listHistory({
        limit: PAGE_SIZE,
        offset: items.length,
      });
      if (next.length === 0) {
        setReachedEnd(true);
      } else {
        const existingIds = new Set(items.map((i) => i.id));
        const deduped = next.filter((i) => !existingIds.has(i.id));
        setItems([...items, ...deduped]);
        if (next.length < PAGE_SIZE) setReachedEnd(true);
      }
    } catch (e) {
      setError((e as Error).message ?? 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  }, [items, loadingMore, reachedEnd, setItems]);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (items.length === 0) {
      void refresh();
    }
  }, [items.length, refresh]);

  const handleClearAll = useCallback(async () => {
    const ok = window.confirm(
      'Delete all history? This permanently removes every generated WAV. This cannot be undone.'
    );
    if (!ok) return;
    const res = await clearHistory(true);
    if (res.ok) {
      setItems([]);
      setReachedEnd(true);
    } else {
      setError('Clear failed');
    }
  }, [setItems]);

  const handleDeleted = useCallback(
    (id: string) => {
      setItems(items.filter((i) => i.id !== id));
    },
    [items, setItems]
  );

  return (
    <section className="view history-view">
      <header className="history-toolbar">
        <h2>
          History{' '}
          <span className="muted history-count">
            ({items.length} item{items.length === 1 ? '' : 's'})
          </span>
        </h2>
        <div className="history-toolbar-actions">
          <button
            type="button"
            className="btn"
            onClick={() => void refresh()}
            disabled={loading}
            data-testid="history-refresh"
          >
            ↻ Refresh
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleClearAll}
            disabled={items.length === 0}
            data-testid="history-clear-all"
          >
            Clear All
          </button>
        </div>
      </header>

      {error && <p className="history-error" role="alert">{error}</p>}

      <div className="history-body">
        {loading ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="history-empty" data-testid="history-empty">
            <p>No generations yet.</p>
            <p className="muted">
              Head to Generate to create some.
            </p>
          </div>
        ) : (
          <ul className="history-list" role="list">
            {items.map((item) => (
              <li key={item.id}>
                <HistoryItem item={item} onDeleted={handleDeleted} />
              </li>
            ))}
          </ul>
        )}

        {!loading && items.length > 0 && !reachedEnd && (
          <div className="history-load-more">
            <button
              type="button"
              className="btn"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              data-testid="history-load-more"
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
