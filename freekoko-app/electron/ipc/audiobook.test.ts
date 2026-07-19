import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Covers the two non-trivial branches of runAudiobookJob: atomic WAV write
// (one numbered file per source) and resume-skip (existing output not
// re-synthesized). `fetchTTSStream` is stubbed so no sidecar is needed.

const hoisted = vi.hoisted(() => ({ fetchTTSStreamMock: vi.fn() }));

// handlers.ts pulls `electron` at module load — stub the surface it touches.
vi.mock('electron', () => ({
  ipcMain: { handle() {}, removeHandler() {} },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('../sidecar/SidecarClient', () => ({
  fetchTTSStream: hoisted.fetchTTSStreamMock,
  fetchTTS: vi.fn(),
  fetchVoices: vi.fn(),
  SidecarHttpError: class extends Error {},
}));

// Import after mocks are registered.
const { runAudiobookJob } = await import('./handlers');

function oneSampleFrame() {
  // 4 bytes = one Float32 LE sample; assembleFloat32WithSilence needs %4==0.
  return new Uint8Array(4);
}

let dir: string;
let srcA: string;
let srcB: string;
let outDir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'audiobook-'));
  srcA = path.join(dir, 'a.txt');
  srcB = path.join(dir, 'b.txt');
  outDir = path.join(dir, 'out');
  await fsp.writeFile(srcA, 'Chapter one.');
  await fsp.writeFile(srcB, 'Chapter two.');
  await fsp.mkdir(outDir);
  hoisted.fetchTTSStreamMock.mockReset();
  hoisted.fetchTTSStreamMock.mockImplementation(
    async (_port, _req, onFrame: (f: unknown) => void) => {
      const pcm = oneSampleFrame();
      onFrame({ chunkIndex: 0, totalChunks: 1, sampleRate: 24000, pcm });
      return { sampleRate: 24000, totalChunks: 1, chunks: [pcm] };
    }
  );
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('runAudiobookJob', () => {
  it('writes one numbered WAV per source file', async () => {
    const res = await runAudiobookJob({
      port: 5002,
      job: { files: [srcA, srcB], outDir, voice: 'af_heart', speed: 1.0 },
      signal: new AbortController().signal,
      onProgress: () => {},
    });

    expect(res).toEqual({ written: 2, skipped: 0, cancelled: false });
    expect(hoisted.fetchTTSStreamMock).toHaveBeenCalledTimes(2);
    const wavA = path.join(outDir, '001_a.wav');
    const wavB = path.join(outDir, '002_b.wav');
    expect(fs.existsSync(wavA)).toBe(true);
    expect(fs.existsSync(wavB)).toBe(true);
    expect(fs.statSync(wavA).size).toBeGreaterThan(44); // header + samples
    // No stray .tmp left behind by the atomic write.
    expect(fs.existsSync(wavA + '.tmp')).toBe(false);
  });

  it('skips a chapter whose output already exists (resume)', async () => {
    await fsp.writeFile(path.join(outDir, '001_a.wav'), 'pre-existing');

    const res = await runAudiobookJob({
      port: 5002,
      job: { files: [srcA, srcB], outDir, voice: 'af_heart', speed: 1.0 },
      signal: new AbortController().signal,
      onProgress: () => {},
    });

    expect(res).toEqual({ written: 1, skipped: 1, cancelled: false });
    // Only the second, un-synthesized file hit the engine.
    expect(hoisted.fetchTTSStreamMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(outDir, '002_b.wav'))).toBe(true);
  });
});
