import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  INTER_CHUNK_SILENCE_SAMPLES,
  assembleFloat32WithSilence,
} from './assembleFloat32WithSilence';

// -----------------------------------------------------------------------------
// Helpers — convert Float32 sample arrays to the wire byte form the assembler
// receives off `/tts/stream`.
// -----------------------------------------------------------------------------

function f32Bytes(samples: number[]): Uint8Array {
  const arr = new Float32Array(samples);
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** Round-trip a sample list through Float32 so equality holds bit-for-bit. */
function f32Trip(samples: number[]): number[] {
  return Array.from(new Float32Array(samples));
}

describe('assembleFloat32WithSilence', () => {
  it('returns an empty Float32Array for zero chunks', () => {
    const out = assembleFloat32WithSilence([]);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(0);
  });

  it('N=1: emits the chunk verbatim with no silence padding', () => {
    const chunk = [0.5, -0.5, 0.25];
    const out = assembleFloat32WithSilence(
      [f32Bytes(chunk)],
      INTER_CHUNK_SILENCE_SAMPLES
    );
    expect(out.length).toBe(chunk.length);
    expect(Array.from(out)).toEqual(f32Trip(chunk));
  });

  it('N=2: inserts exactly INTER_CHUNK_SILENCE_SAMPLES zeros between chunks', () => {
    const a = [1, 2, 3];
    const b = [4, 5];
    const out = assembleFloat32WithSilence(
      [f32Bytes(a), f32Bytes(b)],
      INTER_CHUNK_SILENCE_SAMPLES
    );
    expect(out.length).toBe(a.length + INTER_CHUNK_SILENCE_SAMPLES + b.length);
    // Chunk A samples come first, verbatim (integers — Float32 holds them exactly).
    expect(Array.from(out.subarray(0, a.length))).toEqual(a);
    // Then INTER_CHUNK_SILENCE_SAMPLES zeros.
    const silence = out.subarray(a.length, a.length + INTER_CHUNK_SILENCE_SAMPLES);
    expect(silence.length).toBe(INTER_CHUNK_SILENCE_SAMPLES);
    for (let i = 0; i < silence.length; i++) {
      expect(silence[i], `silence sample ${i}`).toBe(0);
    }
    // Then chunk B.
    expect(Array.from(out.subarray(a.length + INTER_CHUNK_SILENCE_SAMPLES))).toEqual(b);
  });

  it('N=3: inserts exactly 2 silence gaps (one between each consecutive pair)', () => {
    // Use Float32-exact values (powers of 2 fractions) so equality holds
    // bit-for-bit without rounding noise.
    const a = [0.5];
    const b = [0.25, 0.125];
    const c = [-0.5, 0.0625, -0.25];
    const out = assembleFloat32WithSilence(
      [f32Bytes(a), f32Bytes(b), f32Bytes(c)],
      INTER_CHUNK_SILENCE_SAMPLES
    );
    const expectedLen =
      a.length + INTER_CHUNK_SILENCE_SAMPLES + b.length + INTER_CHUNK_SILENCE_SAMPLES + c.length;
    expect(out.length).toBe(expectedLen);
    // Silence gap 1
    let cursor = a.length;
    for (let i = 0; i < INTER_CHUNK_SILENCE_SAMPLES; i++) {
      expect(out[cursor + i]).toBe(0);
    }
    cursor += INTER_CHUNK_SILENCE_SAMPLES;
    expect(Array.from(out.subarray(cursor, cursor + b.length))).toEqual(b);
    cursor += b.length;
    // Silence gap 2
    for (let i = 0; i < INTER_CHUNK_SILENCE_SAMPLES; i++) {
      expect(out[cursor + i]).toBe(0);
    }
    cursor += INTER_CHUNK_SILENCE_SAMPLES;
    expect(Array.from(out.subarray(cursor))).toEqual(c);
  });

  it('handles an empty chunk in the middle as a real chunk (silence on both boundaries)', () => {
    const a = [0.5];
    const empty: number[] = [];
    const c = [0.25];
    const out = assembleFloat32WithSilence(
      [f32Bytes(a), f32Bytes(empty), f32Bytes(c)],
      INTER_CHUNK_SILENCE_SAMPLES
    );
    // 1 + silence + 0 + silence + 1
    expect(out.length).toBe(a.length + INTER_CHUNK_SILENCE_SAMPLES + 0 + INTER_CHUNK_SILENCE_SAMPLES + c.length);
    expect(out[0]).toBe(0.5);
    // last sample is the c chunk
    expect(out[out.length - 1]).toBe(0.25);
  });

  it('handles a single empty chunk (no padding inserted)', () => {
    const out = assembleFloat32WithSilence([f32Bytes([])], INTER_CHUNK_SILENCE_SAMPLES);
    expect(out.length).toBe(0);
  });

  it('rejects a chunk whose byteLength is not a multiple of 4', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]); // 5 bytes — invalid
    expect(() =>
      assembleFloat32WithSilence([garbage], INTER_CHUNK_SILENCE_SAMPLES)
    ).toThrowError(/multiple of 4/);
  });

  it('default silence count matches sidecar TTSHandler.swift (3600 = 0.15s × 24kHz)', () => {
    expect(INTER_CHUNK_SILENCE_SAMPLES).toBe(3600);
  });

  // -------------------------------------------------------------------------
  // Architectural guard: the silence padding MUST live in the WAV-assembly
  // layer, not the wire-protocol parser. A regression that re-inserted
  // silence inside `StreamFrameParser` would double-count the gap on the
  // renderer side. This test fails loudly if anyone adds silence-insertion
  // logic into the wire parser.
  // -------------------------------------------------------------------------
  it('the wire-protocol parser does not contain silence-insertion logic', () => {
    const parserPath = path.join(__dirname, '..', 'sidecar', 'SidecarClient.ts');
    const src = fs.readFileSync(parserPath, 'utf8');
    // Pull just the StreamFrameParser class body (defensive — substring
    // makes the assertion robust to edits elsewhere in the file, like the
    // imports section growing).
    const start = src.indexOf('class StreamFrameParser');
    const end = src.indexOf('export async function fetchTTSStream', start);
    expect(start, 'StreamFrameParser class located').toBeGreaterThan(-1);
    expect(end, 'fetchTTSStream located after parser').toBeGreaterThan(start);
    const parserBody = src.slice(start, end);
    expect(parserBody.includes('INTER_CHUNK_SILENCE_SAMPLES')).toBe(false);
    expect(parserBody.includes('assembleFloat32WithSilence')).toBe(false);
    // Catch-all for hardcoded constants matching our padding.
    expect(parserBody.includes('3600')).toBe(false);
  });
});
