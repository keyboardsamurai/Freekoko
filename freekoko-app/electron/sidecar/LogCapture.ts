import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import type { LogEntry, LogLevel } from '../types';

const RING_MAX = 1000;
const VALID_LEVELS: ReadonlySet<LogLevel> = new Set([
  'debug',
  'info',
  'warn',
  'error',
]);

export interface LogCaptureOptions {
  /** Called for every log entry with a sanitized LogEntry. */
  onEntry?: (entry: LogEntry) => void;
  /** Appends raw strings to a rolling file (electron-log typically). */
  fileAppender?: (line: string) => void;
}

/**
 * Parses newline-delimited JSON from a child's stdout/stderr, falling back
 * to a raw wrapper for lines that fail to parse. Maintains a ring buffer
 * of the most recent 1000 entries and forwards entries to listeners.
 */
export class LogCapture extends EventEmitter {
  private ring: LogEntry[] = [];
  private onEntry?: (entry: LogEntry) => void;
  private fileAppender?: (line: string) => void;

  constructor(opts: LogCaptureOptions = {}) {
    super();
    this.onEntry = opts.onEntry;
    this.fileAppender = opts.fileAppender;
  }

  attachStream(stream: Readable, source: 'stdout' | 'stderr' = 'stdout'): void {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => this.ingestLine(line, source));
    rl.on('close', () => {
      /* stream closed — nothing to do */
    });
  }

  /** Public for tests: parses a single raw line and returns the LogEntry. */
  ingestLine(raw: string, source: 'stdout' | 'stderr' = 'stdout'): LogEntry {
    const trimmed = raw.trimEnd();
    let entry: LogEntry;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      entry = this.normalize(parsed, source);
    } catch {
      entry = {
        ts: new Date().toISOString(),
        level: source === 'stderr' ? 'error' : 'info',
        msg: trimmed,
        event: 'raw',
        message: trimmed,
      };
    }
    this.push(entry);
    return entry;
  }

  private normalize(
    parsed: Record<string, unknown>,
    source: 'stdout' | 'stderr'
  ): LogEntry {
    const ts =
      typeof parsed.ts === 'string' ? parsed.ts : new Date().toISOString();
    const levelRaw = typeof parsed.level === 'string' ? parsed.level : '';
    const level: LogLevel = VALID_LEVELS.has(levelRaw as LogLevel)
      ? (levelRaw as LogLevel)
      : source === 'stderr'
        ? 'error'
        : 'info';
    const msg =
      typeof parsed.msg === 'string'
        ? parsed.msg
        : typeof parsed.message === 'string'
          ? (parsed.message as string)
          : '';
    const entry: LogEntry = { ...parsed, ts, level, msg };
    return entry;
  }

  private push(entry: LogEntry): void {
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) {
      this.ring.splice(0, this.ring.length - RING_MAX);
    }
    if (this.fileAppender) {
      try {
        this.fileAppender(JSON.stringify(entry));
      } catch {
        /* best effort */
      }
    }
    if (this.onEntry) {
      try {
        this.onEntry(entry);
      } catch {
        /* swallow — one bad listener shouldn't break capture */
      }
    }
    this.emit('entry', entry);
  }

  recent(limit = RING_MAX): LogEntry[] {
    if (limit >= this.ring.length) return [...this.ring];
    return this.ring.slice(this.ring.length - limit);
  }

  clear(): void {
    this.ring = [];
  }
}
