// electron/history/wavEncode.ts
//
// Pure-Node RIFF/WAVE PCM 16-bit encoder. Direct port of the sidecar's
// `WAVEncoder.swift` so the WAV produced by the streaming path is byte-
// identical to what `/tts` emits today (for the same input PCM).
//
// Header layout (44 bytes):
//   0  "RIFF"              4
//   4  file size - 8       4  UInt32 LE
//   8  "WAVE"              4
//  12  "fmt "              4
//  16  fmt chunk size=16   4  UInt32 LE
//  20  audio format=1      2  UInt16 LE (PCM)
//  22  numChannels         2  UInt16 LE
//  24  sampleRate          4  UInt32 LE
//  28  byteRate            4  UInt32 LE
//  32  blockAlign          2  UInt16 LE
//  34  bitsPerSample=16    2  UInt16 LE
//  36  "data"              4
//  40  data size           4  UInt32 LE
//  44  samples ...         N

const NUM_CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
// Match Swift's `Int16(clamped * Float(Int16.max))`: scale by 32767, not 32768.
const INT16_MAX = 32767;

/**
 * Encode mono Float32 samples (range [-1.0, 1.0]) into a WAV `Buffer`.
 * Output is byte-identical to `WAVEncoder.encode(samples:sampleRate:)`
 * in `freekoko-sidecar/Sources/FreekokoSidecar/Audio/WAVEncoder.swift`.
 */
export function encodeWav(float32: Float32Array, sampleRate: number): Buffer {
  const numSamples = float32.length;
  const dataSize = numSamples * BYTES_PER_SAMPLE;
  const fileSize = 36 + dataSize; // file size minus the 8-byte RIFF prefix
  const byteRate = sampleRate * NUM_CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = NUM_CHANNELS * BYTES_PER_SAMPLE;

  const buf = Buffer.alloc(44 + dataSize);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // RIFF header
  buf.write('RIFF', 0, 'ascii');
  dv.setUint32(4, fileSize, true);
  buf.write('WAVE', 8, 'ascii');

  // fmt subchunk
  buf.write('fmt ', 12, 'ascii');
  dv.setUint32(16, 16, true);            // PCM fmt chunk size
  dv.setUint16(20, 1, true);             // audio format: 1 = PCM
  dv.setUint16(22, NUM_CHANNELS, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, BITS_PER_SAMPLE, true);

  // data subchunk
  buf.write('data', 36, 'ascii');
  dv.setUint32(40, dataSize, true);

  // Samples: Float -> clamped Int16, little-endian.
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = float32[i];
    const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
    // Swift's `Int16(x)` truncates toward zero; JS `Math.trunc` matches.
    const value = Math.trunc(clamped * INT16_MAX);
    dv.setInt16(offset, value, true);
    offset += 2;
  }

  return buf;
}
