import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type { HistoryItem } from '../types';

const INDEX_FILENAME = 'index.json';
const INDEX_TMP_FILENAME = 'index.json.tmp';

/** Hard cap on retained entries; older entries (and their WAVs) are evicted. */
export const HISTORY_MAX_ENTRIES = 500;

/** Preview window used by the list UI. */
const PREVIEW_MAX_CHARS = 120;

export interface HistoryAddInput {
  text: string;
  voice: string;
  speed: number;
  wavBuffer: Buffer;
  sampleCount: number;
  durationMs: number;
  /** Optional override; tests/callers can pass a stable id. */
  id?: string;
  /** Optional override; defaults to `new Date().toISOString()`. */
  createdAt?: string;
}

/**
 * Persists generated WAVs and a reverse-chronological JSON index.
 *
 * Layout (inside `baseDir`):
 *   index.json        — HistoryItem[], newest first.
 *   {uuid}.wav        — one WAV file per entry.
 *
 * The index is written atomically (tmp file + rename) to survive crashes
 * mid-write. On trim, evicted WAVs are deleted as a best effort — failures
 * are swallowed to keep `add()` resilient.
 */
export class HistoryStore {
  private readonly baseDir: string;
  private readonly maxEntries: number;
  private items: HistoryItem[] = [];
  private initialized = false;

  constructor(baseDir: string, opts: { maxEntries?: number } = {}) {
    this.baseDir = baseDir;
    this.maxEntries = opts.maxEntries ?? HISTORY_MAX_ENTRIES;
  }

  get dir(): string {
    return this.baseDir;
  }

  /** Ensures the directory exists and loads the index into memory. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await fsp.mkdir(this.baseDir, { recursive: true });
    const indexPath = path.join(this.baseDir, INDEX_FILENAME);
    try {
      const raw = await fsp.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.items = parsed.filter((x): x is HistoryItem => isHistoryItem(x));
      } else {
        this.items = [];
      }
    } catch (err: unknown) {
      // ENOENT is expected on a fresh install; any other parse error
      // is treated as a corrupt index and reset to empty (WAVs stay).
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        this.items = [];
        await this.writeIndex();
      } else {
        this.items = [];
        await this.writeIndex();
      }
    }
    this.initialized = true;
  }

  /** Adds a new entry. Writes the WAV, prepends to index, trims, and persists. */
  async add(input: HistoryAddInput): Promise<HistoryItem> {
    await this.init();
    const id = input.id ?? crypto.randomUUID();
    const wavFilename = `${id}.wav`;
    const wavPath = path.join(this.baseDir, wavFilename);
    const previewText = makePreview(input.text);
    const createdAt = input.createdAt ?? new Date().toISOString();

    await fsp.writeFile(wavPath, input.wavBuffer);

    const item: HistoryItem = {
      id,
      createdAt,
      text: input.text,
      voice: input.voice,
      speed: input.speed,
      sampleCount: input.sampleCount,
      durationMs: input.durationMs,
      wavFilename,
      previewText,
    };

    this.items.unshift(item);

    if (this.items.length > this.maxEntries) {
      const evicted = this.items.slice(this.maxEntries);
      this.items = this.items.slice(0, this.maxEntries);
      for (const dead of evicted) {
        await this.deleteWavQuietly(dead.wavFilename);
      }
    }

    await this.writeIndex();
    return item;
  }

  /** Returns entries in reverse-chronological order (newest first). */
  async list(limit = 50, offset = 0): Promise<HistoryItem[]> {
    await this.init();
    const safeLimit = Math.max(0, Math.min(limit, this.items.length));
    const safeOffset = Math.max(0, Math.min(offset, this.items.length));
    return this.items.slice(safeOffset, safeOffset + safeLimit);
  }

  async get(
    id: string
  ): Promise<{ item: HistoryItem; wavPath: string } | null> {
    await this.init();
    const item = this.items.find((it) => it.id === id);
    if (!item) return null;
    return {
      item,
      wavPath: path.join(this.baseDir, item.wavFilename),
    };
  }

  /** Returns true if an entry was removed. */
  async delete(id: string): Promise<boolean> {
    await this.init();
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    const [removed] = this.items.splice(idx, 1);
    await this.writeIndex();
    if (removed) await this.deleteWavQuietly(removed.wavFilename);
    return true;
  }

  /** Deletes every WAV and resets the index to empty. */
  async clear(): Promise<void> {
    await this.init();
    const toDelete = this.items.slice();
    this.items = [];
    await this.writeIndex();
    for (const it of toDelete) {
      await this.deleteWavQuietly(it.wavFilename);
    }
  }

  /**
   * Read the raw WAV bytes for a history entry. Returns null when the id
   * is unknown or the file is missing.
   */
  async readWav(id: string): Promise<Buffer | null> {
    const hit = await this.get(id);
    if (!hit) return null;
    try {
      return await fsp.readFile(hit.wavPath);
    } catch {
      return null;
    }
  }

  /** Copies the WAV for `id` to `destPath`. Returns the destPath on success. */
  async saveWavAs(id: string, destPath: string): Promise<string | null> {
    const hit = await this.get(id);
    if (!hit) return null;
    await fsp.copyFile(hit.wavPath, destPath);
    return destPath;
  }

  // -------------------------------------------------------------- internals

  private async writeIndex(): Promise<void> {
    const indexPath = path.join(this.baseDir, INDEX_FILENAME);
    const tmpPath = path.join(this.baseDir, INDEX_TMP_FILENAME);
    const body = JSON.stringify(this.items, null, 2);
    await fsp.writeFile(tmpPath, body, 'utf8');
    await fsp.rename(tmpPath, indexPath);
  }

  private async deleteWavQuietly(wavFilename: string): Promise<void> {
    const wavPath = path.join(this.baseDir, wavFilename);
    try {
      await fsp.unlink(wavPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && code !== 'ENOENT') {
        // Swallow — deletion is best-effort. Caller has already updated
        // the index; a stale WAV will be re-evicted on next trim.
      }
    }
  }
}

function makePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= PREVIEW_MAX_CHARS
    ? collapsed
    : collapsed.slice(0, PREVIEW_MAX_CHARS - 1) + '\u2026';
}

function isHistoryItem(x: unknown): x is HistoryItem {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.createdAt === 'string' &&
    typeof o.text === 'string' &&
    typeof o.voice === 'string' &&
    typeof o.speed === 'number' &&
    typeof o.sampleCount === 'number' &&
    typeof o.durationMs === 'number' &&
    typeof o.wavFilename === 'string' &&
    typeof o.previewText === 'string'
  );
}

/** Factory used by main.ts; kept separate so tests can stub the path. */
export function createHistoryStore(userDataDir: string): HistoryStore {
  return new HistoryStore(path.join(userDataDir, 'history'));
}

/** Eager directory check — returns true when `dir` exists. */
export async function historyDirExists(dir: string): Promise<boolean> {
  try {
    const st = await fsp.stat(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
}

// re-exported for callers that want the sync existence check (main.ts).
export { fs };
