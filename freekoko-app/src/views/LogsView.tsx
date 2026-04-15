import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLogsStore } from '../store/useLogsStore';
import { clearLogs } from '../lib/ipc';
import { LogLine } from '../components/LogLine';
import { VirtualList, type VirtualListHandle } from '../components/VirtualList';
import type { LogEntry, LogLevel } from '../lib/types';

const LEVELS: ReadonlyArray<'all' | LogLevel> = [
  'all',
  'debug',
  'info',
  'warn',
  'error',
];

const ROW_HEIGHT = 20;

export function LogsView() {
  const lines = useLogsStore((s) => s.lines);
  const clearLocal = useLogsStore((s) => s.clear);

  const [filter, setFilter] = useState<'all' | LogLevel>('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const listRef = useRef<VirtualListHandle>(null);
  const prevLenRef = useRef(0);

  const filtered = useMemo<LogEntry[]>(() => {
    if (filter === 'all') return lines;
    return lines.filter((l) => l.level === filter);
  }, [lines, filter]);

  // Auto-scroll to bottom when new lines arrive *and* user hasn't
  // scrolled up. If the user has scrolled up, accumulate a pending
  // counter so the UI can surface an "N new" pill.
  useEffect(() => {
    const added = filtered.length - prevLenRef.current;
    prevLenRef.current = filtered.length;
    if (added <= 0) return;

    const el = listRef.current;
    if (!el) return;

    // Initial mount: always snap to the bottom.
    if (autoScroll) {
      // Defer to next frame so layout settles (container height may still
      // be resolving from its ResizeObserver).
      requestAnimationFrame(() => {
        el.scrollToBottom();
      });
      setPendingCount(0);
    } else {
      setPendingCount((c) => c + added);
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.isAtBottom(40);
    setAutoScroll(atBottom);
    if (atBottom) setPendingCount(0);
  }, []);

  const handleClear = useCallback(async () => {
    await clearLogs();
    clearLocal();
    setPendingCount(0);
  }, [clearLocal]);

  const handleJumpToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollToBottom();
    setAutoScroll(true);
    setPendingCount(0);
  }, []);

  return (
    <section className="view logs-view">
      <header className="logs-toolbar">
        <h2>Logs</h2>
        <div className="logs-filter-group" role="radiogroup" aria-label="Filter by level">
          {LEVELS.map((lvl) => (
            <button
              type="button"
              key={lvl}
              role="radio"
              aria-checked={filter === lvl}
              className={`log-filter-chip${filter === lvl ? ' log-filter-chip-active' : ''}`}
              onClick={() => setFilter(lvl)}
              data-testid={`log-filter-${lvl}`}
            >
              {lvl.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="logs-autoscroll-toggle">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => {
              const next = e.target.checked;
              setAutoScroll(next);
              if (next) handleJumpToBottom();
            }}
            data-testid="logs-autoscroll-toggle"
          />{' '}
          Auto-scroll
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => void handleClear()}
          data-testid="logs-clear"
        >
          Clear
        </button>
      </header>

      <div className="logs-body" data-testid="logs-body">
        {filtered.length === 0 ? (
          <p className="muted logs-empty">
            {lines.length === 0
              ? 'No sidecar logs yet. Start the server to see output.'
              : `No ${filter.toUpperCase()} entries.`}
          </p>
        ) : (
          <VirtualList<LogEntry>
            ref={listRef}
            items={filtered}
            itemHeight={ROW_HEIGHT}
            overscan={15}
            className="logs-virtual"
            onScroll={handleScroll}
            role="log"
            ariaLive="polite"
            ariaLabel="Sidecar log output"
            renderItem={(entry) => <LogLine entry={entry} />}
          />
        )}

        {pendingCount > 0 && (
          <button
            type="button"
            className="logs-new-pill"
            onClick={handleJumpToBottom}
            data-testid="logs-new-pill"
          >
            ↓ {pendingCount} new
          </button>
        )}
      </div>
    </section>
  );
}
