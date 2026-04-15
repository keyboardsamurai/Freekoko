import { describe, expect, it } from 'vitest';

import { encodeWav } from '../history/wavEncode';

const SAMPLE_RATE = 24000;
const INT16_MAX = 32767;

/**
 * Independent re-implementation of the Swift `WAVEncoder.encode` reference
 * used purely as a test oracle. If `encodeWav` ever drifts from the wire
 * format it must drift here too — at which point the inline header-field
 * assertions below catch the mistake regardless.
 */
function buildReferenceWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = 36 + dataSize;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;

  const buf = Buffer.alloc(44 + dataSize);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf.write('RIFF', 0, 'ascii');
  dv.setUint32(4, fileSize, true);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  buf.write('data', 36, 'ascii');
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
    dv.setInt16(44 + i * 2, Math.trunc(clamped * INT16_MAX), true);
  }
  return buf;
}

function makeSine(n: number, freqHz: number, sampleRate: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

describe('encodeWav', () => {
  it('matches the reference byte-for-byte for a 100-sample sine', () => {
    const samples = makeSine(100, 440, SAMPLE_RATE);
    const got = encodeWav(samples, SAMPLE_RATE);
    const ref = buildReferenceWav(samples, SAMPLE_RATE);
    expect(got.length).toBe(ref.length);
    expect(got.equals(ref)).toBe(true);
  });

  it('writes the canonical RIFF header fields', () => {
    const samples = makeSine(100, 440, SAMPLE_RATE);
    const buf = encodeWav(samples, SAMPLE_RATE);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    // 44-byte header + 100 samples * 2 bytes = 244 total bytes.
    expect(buf.length).toBe(44 + 100 * 2);

    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(dv.getUint32(4, true)).toBe(36 + 100 * 2);
    expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(buf.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(dv.getUint32(16, true)).toBe(16);     // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(1);      // PCM
    expect(dv.getUint16(22, true)).toBe(1);      // mono
    expect(dv.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(dv.getUint32(28, true)).toBe(SAMPLE_RATE * 1 * 2); // byte rate
    expect(dv.getUint16(32, true)).toBe(2);      // block align
    expect(dv.getUint16(34, true)).toBe(16);     // bits per sample
    expect(buf.subarray(36, 40).toString('ascii')).toBe('data');
    expect(dv.getUint32(40, true)).toBe(100 * 2);
  });

  it('clamps samples outside [-1, 1] and rounds toward zero', () => {
    const samples = new Float32Array([0, 1, -1, 2, -2, 0.5, -0.5]);
    const buf = encodeWav(samples, SAMPLE_RATE);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    // Header is 44 bytes; sample i lives at offset 44 + i*2.
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(46, true)).toBe(INT16_MAX);   // +1.0 → +32767
    expect(dv.getInt16(48, true)).toBe(-INT16_MAX);  // -1.0 → -32767
    expect(dv.getInt16(50, true)).toBe(INT16_MAX);   // +2.0 clamped → +32767
    expect(dv.getInt16(52, true)).toBe(-INT16_MAX);  // -2.0 clamped → -32767
    expect(dv.getInt16(54, true)).toBe(Math.trunc(0.5 * INT16_MAX));
    expect(dv.getInt16(56, true)).toBe(Math.trunc(-0.5 * INT16_MAX));
  });

  it('produces a 44-byte header for an empty sample array', () => {
    const buf = encodeWav(new Float32Array(0), SAMPLE_RATE);
    expect(buf.length).toBe(44);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    expect(dv.getUint32(40, true)).toBe(0);     // data size
    expect(dv.getUint32(4, true)).toBe(36);     // file size - 8
  });
});
