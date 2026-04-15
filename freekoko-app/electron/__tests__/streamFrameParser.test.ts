import { describe, expect, it } from 'vitest';

import { StreamFrameParser, type StreamFrame } from '../sidecar/SidecarClient';

// -----------------------------------------------------------------------------
// Synthetic-frame helpers
// -----------------------------------------------------------------------------

const MAGIC = Buffer.from('FKST', 'ascii');

interface SynthChunk {
  index: number;
  /** Little-endian Float32 sample bytes (length must be a multiple of 4). */
  pcm: Uint8Array;
}

function buildPreamble(sampleRate: number, totalChunks: number): Buffer {
  const buf = Buffer.alloc(16);
  MAGIC.copy(buf, 0);
  buf.writeUInt32BE(sampleRate, 4);
  buf.writeUInt32BE(totalChunks, 8);
  buf.writeUInt32BE(0, 12); // reserved
  return buf;
}

function buildFrame(c: SynthChunk): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(c.index, 0);
  header.writeUInt32BE(c.pcm.byteLength, 4);
  return Buffer.concat([header, Buffer.from(c.pcm)]);
}

function makePcm(values: number[]): Uint8Array {
  const f = new Float32Array(values);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

function buildStream(sampleRate: number, chunks: SynthChunk[]): Buffer {
  return Buffer.concat([
    buildPreamble(sampleRate, chunks.length),
    ...chunks.map(buildFrame),
  ]);
}

function feedInChunks(parser: StreamFrameParser, stream: Buffer, chunkSize: number): StreamFrame[] {
  const collected: StreamFrame[] = [];
  for (let i = 0; i < stream.length; i += chunkSize) {
    const slice = stream.subarray(i, Math.min(i + chunkSize, stream.length));
    parser.push(new Uint8Array(slice), (f) => {
      // Copy out — the parser's `pcm` view points into its rolling buffer
      // which gets reassigned mid-loop in some boundary cases.
      collected.push({
        chunkIndex: f.chunkIndex,
        totalChunks: f.totalChunks,
        sampleRate: f.sampleRate,
        pcm: new Uint8Array(f.pcm),
      });
    });
  }
  return collected;
}

function pcmEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('StreamFrameParser', () => {
  it('parses a complete stream delivered as one buffer', () => {
    const chunks: SynthChunk[] = [
      { index: 0, pcm: makePcm([0, 0.5, -0.5, 1, -1]) },
      { index: 1, pcm: makePcm([0.25, -0.25]) },
      { index: 2, pcm: makePcm([0.1, 0.2, 0.3]) },
    ];
    const stream = buildStream(24000, chunks);
    const parser = new StreamFrameParser();
    const got = feedInChunks(parser, stream, stream.length);

    expect(got).toHaveLength(3);
    expect(got.map((f) => f.chunkIndex)).toEqual([0, 1, 2]);
    expect(got.every((f) => f.sampleRate === 24000)).toBe(true);
    expect(got.every((f) => f.totalChunks === 3)).toBe(true);
    for (let i = 0; i < chunks.length; i++) {
      expect(pcmEq(got[i].pcm, chunks[i].pcm)).toBe(true);
    }
    expect(parser.remainingBytes()).toBe(0);
  });

  it('fuzzes split-boundary cases at every chunk size 1..17', () => {
    const chunks: SynthChunk[] = [
      { index: 0, pcm: makePcm([0.1, 0.2, 0.3, 0.4]) },
      { index: 1, pcm: makePcm([-0.1, -0.2, -0.3]) },
      { index: 2, pcm: makePcm([0.99]) },
      { index: 3, pcm: makePcm([0.5, -0.5, 0.25, -0.25, 0.125, -0.125]) },
    ];
    const stream = buildStream(24000, chunks);

    for (let chunkSize = 1; chunkSize <= 17; chunkSize++) {
      const parser = new StreamFrameParser();
      const got = feedInChunks(parser, stream, chunkSize);
      expect(got, `chunkSize=${chunkSize}`).toHaveLength(chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        expect(got[i].chunkIndex, `chunkSize=${chunkSize} i=${i}`).toBe(chunks[i].index);
        expect(pcmEq(got[i].pcm, chunks[i].pcm), `chunkSize=${chunkSize} i=${i}`).toBe(true);
        expect(got[i].totalChunks).toBe(chunks.length);
        expect(got[i].sampleRate).toBe(24000);
      }
      expect(parser.remainingBytes(), `chunkSize=${chunkSize} leftover`).toBe(0);
    }
  });

  it('handles preamble split across two reads (5 + 11)', () => {
    const chunks: SynthChunk[] = [{ index: 0, pcm: makePcm([0.1, 0.2]) }];
    const stream = buildStream(24000, chunks);
    const parser = new StreamFrameParser();

    const got: StreamFrame[] = [];
    parser.push(new Uint8Array(stream.subarray(0, 5)), (f) => got.push(f));
    expect(got).toHaveLength(0);
    expect(parser.hasPreamble).toBe(false);
    parser.push(new Uint8Array(stream.subarray(5)), (f) =>
      got.push({ ...f, pcm: new Uint8Array(f.pcm) })
    );
    expect(parser.hasPreamble).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0].sampleRate).toBe(24000);
    expect(pcmEq(got[0].pcm, chunks[0].pcm)).toBe(true);
  });

  it('handles frame-header split across reads', () => {
    const chunks: SynthChunk[] = [
      { index: 0, pcm: makePcm([0.5]) },
      { index: 1, pcm: makePcm([-0.5]) },
    ];
    const stream = buildStream(24000, chunks);
    // Cut just after the preamble + 4 bytes of the first frame header.
    const cut = 16 + 4;
    const parser = new StreamFrameParser();
    const got: StreamFrame[] = [];
    parser.push(new Uint8Array(stream.subarray(0, cut)), (f) =>
      got.push({ ...f, pcm: new Uint8Array(f.pcm) })
    );
    expect(got).toHaveLength(0);
    parser.push(new Uint8Array(stream.subarray(cut)), (f) =>
      got.push({ ...f, pcm: new Uint8Array(f.pcm) })
    );
    expect(got).toHaveLength(2);
    expect(pcmEq(got[0].pcm, chunks[0].pcm)).toBe(true);
    expect(pcmEq(got[1].pcm, chunks[1].pcm)).toBe(true);
  });

  it('handles PCM payload split mid-sample', () => {
    const chunks: SynthChunk[] = [
      { index: 0, pcm: makePcm([0.1, 0.2, 0.3, 0.4]) }, // 16 PCM bytes
    ];
    const stream = buildStream(24000, chunks);
    // Preamble (16) + frame header (8) = 24, then split mid-sample (24+6).
    const cut = 24 + 6;
    const parser = new StreamFrameParser();
    const got: StreamFrame[] = [];
    parser.push(new Uint8Array(stream.subarray(0, cut)), (f) =>
      got.push({ ...f, pcm: new Uint8Array(f.pcm) })
    );
    expect(got).toHaveLength(0);
    parser.push(new Uint8Array(stream.subarray(cut)), (f) =>
      got.push({ ...f, pcm: new Uint8Array(f.pcm) })
    );
    expect(got).toHaveLength(1);
    expect(pcmEq(got[0].pcm, chunks[0].pcm)).toBe(true);
  });

  it('does not leak state — fresh parser yields no frames before data', () => {
    const parser = new StreamFrameParser();
    const got: StreamFrame[] = [];
    parser.push(new Uint8Array(0), (f) => got.push(f));
    expect(got).toHaveLength(0);
    expect(parser.hasPreamble).toBe(false);
    expect(parser.remainingBytes()).toBe(0);
  });

  it('throws on bad magic bytes', () => {
    const bad = Buffer.alloc(16);
    Buffer.from('ZZZZ', 'ascii').copy(bad, 0);
    const parser = new StreamFrameParser();
    expect(() => parser.push(new Uint8Array(bad), () => undefined)).toThrowError(
      /stream_bad_magic/
    );
  });

  it('handles a stream with zero-length PCM frame (empty chunk)', () => {
    const chunks: SynthChunk[] = [
      { index: 0, pcm: makePcm([]) },
      { index: 1, pcm: makePcm([0.5]) },
    ];
    const stream = buildStream(24000, chunks);
    const parser = new StreamFrameParser();
    const got = feedInChunks(parser, stream, 3);
    expect(got).toHaveLength(2);
    expect(got[0].pcm.byteLength).toBe(0);
    expect(pcmEq(got[1].pcm, chunks[1].pcm)).toBe(true);
  });
});
