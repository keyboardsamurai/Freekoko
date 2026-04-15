import { useMemo } from 'react';
import type { LogEntry } from '../lib/types';

export interface LogLineProps {
  entry: LogEntry;
}

// Reserved keys that have dedicated columns; anything else is rendered
// into the compact "fields" trailing span.
const RESERVED_KEYS = new Set(['ts', 'level', 'msg', 'event', 'message']);

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return ts;
    // HH:mm:ss.SSS — cheapest zero-dependency formatter.
    return d.toISOString().substring(11, 23);
  } catch {
    return ts;
  }
}

function formatFields(entry: LogEntry): string {
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (!RESERVED_KEYS.has(k)) extras[k] = v;
  }
  const keys = Object.keys(extras);
  if (keys.length === 0) return '';
  // Compact key=value form for short scalar values, JSON fallback for
  // objects. Keeps a single row-height readable.
  const parts: string[] = [];
  for (const k of keys) {
    const v = extras[k];
    if (v === null || v === undefined) {
      parts.push(`${k}=null`);
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const s = String(v);
      parts.push(`${k}=${s.length > 48 ? s.slice(0, 45) + '…' : s}`);
    } else {
      try {
        parts.push(`${k}=${JSON.stringify(v)}`);
      } catch {
        parts.push(`${k}=?`);
      }
    }
  }
  return parts.join(' ');
}

export function LogLine({ entry }: LogLineProps) {
  const time = useMemo(() => formatTime(entry.ts), [entry.ts]);
  const fields = useMemo(() => formatFields(entry), [entry]);
  const event = entry.event ?? '';
  const msg = entry.msg ?? entry.message ?? '';

  return (
    <div
      className={`log-line log-${entry.level}`}
      data-level={entry.level}
      role="listitem"
    >
      <span className="log-ts">{time}</span>
      <span className={`log-level log-level-${entry.level}`}>
        {entry.level.toUpperCase()}
      </span>
      <span className="log-event">{event}</span>
      <span className="log-msg">{msg}</span>
      {fields && <span className="log-fields">{fields}</span>}
    </div>
  );
}
