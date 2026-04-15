import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { HistoryStore } from './HistoryStore';

function makeTempDir(): string {
  return path.join(os.tmpdir(), `freekoko-history-test-${crypto.randomUUID()}`);
}

function wav(n: number): Buffer {
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(n, 40);
  return b;
}

describe('HistoryStore', () => {
  let dir: string;
  let store: HistoryStore;

  beforeEach(async () => {
    dir = makeTempDir();
    store = new HistoryStore(dir, { maxEntries: 4 });
    await store.init();
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('init() creates the base dir and empty index', async () => {
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(true);
    const raw = await fsp.readFile(path.join(dir, 'index.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual([]);
  });

  it('add() writes WAV, updates the index, and builds preview', async () => {
    const long = 'a'.repeat(300);
    const item = await store.add({
      text: long,
      voice: 'af_heart',
      speed: 1.0,
      wavBuffer: wav(100),
      sampleCount: 24000,
      durationMs: 250,
    });
    expect(item.id).toMatch(/[a-f0-9-]+/i);
    expect(item.wavFilename).toBe(`${item.id}.wav`);
    expect(item.previewText.length).toBeLessThanOrEqual(120);
    expect(item.previewText.endsWith('\u2026')).toBe(true);
    expect(fs.existsSync(path.join(dir, item.wavFilename))).toBe(true);
    const indexRaw = await fsp.readFile(path.join(dir, 'index.json'), 'utf8');
    const index = JSON.parse(indexRaw);
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe(item.id);
  });

  it('list() returns entries newest-first', async () => {
    const a = await store.add({
      text: 'one',
      voice: 'v1',
      speed: 1,
      wavBuffer: wav(10),
      sampleCount: 1,
      durationMs: 1,
    });
    const b = await store.add({
      text: 'two',
      voice: 'v2',
      speed: 1,
      wavBuffer: wav(10),
      sampleCount: 1,
      durationMs: 1,
    });
    const list = await store.list(10, 0);
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it('trims to maxEntries and deletes evicted WAVs', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const it = await store.add({
        text: `item-${i}`,
        voice: 'v',
        speed: 1,
        wavBuffer: wav(10),
        sampleCount: 1,
        durationMs: 1,
      });
      ids.push(it.id);
    }
    const list = await store.list(10, 0);
    expect(list).toHaveLength(4);
    // Newest four survive (reverse-chron order).
    expect(list.map((x) => x.id)).toEqual([ids[5], ids[4], ids[3], ids[2]]);
    // Oldest two WAVs evicted from disk.
    expect(fs.existsSync(path.join(dir, `${ids[0]}.wav`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${ids[1]}.wav`))).toBe(false);
    // Kept WAVs still on disk.
    expect(fs.existsSync(path.join(dir, `${ids[5]}.wav`))).toBe(true);
  });

  it('delete() removes WAV and index entry', async () => {
    const a = await store.add({
      text: 'a',
      voice: 'v',
      speed: 1,
      wavBuffer: wav(10),
      sampleCount: 1,
      durationMs: 1,
    });
    const ok = await store.delete(a.id);
    expect(ok).toBe(true);
    expect(fs.existsSync(path.join(dir, a.wavFilename))).toBe(false);
    const list = await store.list();
    expect(list).toHaveLength(0);
    // Idempotent: second delete returns false.
    expect(await store.delete(a.id)).toBe(false);
  });

  it('clear() wipes every WAV and resets the index', async () => {
    await store.add({
      text: 'a',
      voice: 'v',
      speed: 1,
      wavBuffer: wav(10),
      sampleCount: 1,
      durationMs: 1,
    });
    await store.add({
      text: 'b',
      voice: 'v',
      speed: 1,
      wavBuffer: wav(10),
      sampleCount: 1,
      durationMs: 1,
    });
    await store.clear();
    const list = await store.list();
    expect(list).toHaveLength(0);
    // No WAV files remain (only the index).
    const contents = await fsp.readdir(dir);
    expect(contents.filter((f) => f.endsWith('.wav'))).toEqual([]);
  });

  it('get() returns the item and absolute WAV path', async () => {
    const a = await store.add({
      text: 'a',
      voice: 'v',
      speed: 1,
      wavBuffer: wav(10),
      sampleCount: 1,
      durationMs: 1,
    });
    const hit = await store.get(a.id);
    expect(hit?.item.id).toBe(a.id);
    expect(hit?.wavPath).toBe(path.join(dir, a.wavFilename));
  });

  it('survives a restart and reloads the index', async () => {
    const a = await store.add({
      text: 'persist me',
      voice: 'v',
      speed: 1,
      wavBuffer: wav(10),
      sampleCount: 1,
      durationMs: 1,
    });

    const reopened = new HistoryStore(dir, { maxEntries: 4 });
    await reopened.init();
    const list = await reopened.list();
    expect(list.map((x) => x.id)).toEqual([a.id]);
  });
});
