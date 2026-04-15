// electron/audio/assembleFloat32WithSilence.ts
//
// Concatenate received PCM chunks (raw Float32 LE bytes) into one
// Float32Array, inserting a fixed amount of zero samples between
// consecutive chunks. Mirrors the silence padding that `TTSHandler.swift`
// inserts when assembling the WAV payload that `/tts` returns, so the
// streaming path produces a byte-identical WAV when re-encoded.
//
// IMPORTANT: this padding belongs in the WAV-assembly layer ONLY. It must
// NOT be applied inside the wire-protocol parser (`StreamFrameParser`) —
// the wire payload is speech-only PCM. Re-applying silence inside the
// parser would double-count the gap on the renderer side.
//
// The renderer applies the same `INTER_CHUNK_SILENCE_SECONDS` to its
// `nextStartTime` cursor in `AudioPlayer.tsx`. One canonical silence
// duration, two independent application sites (main + renderer), never
// in the wire protocol.

/** 0.15s × 24000 Hz — must match `TTSHandler.swift` and `AudioPlayer.tsx`. */
export const INTER_CHUNK_SILENCE_SAMPLES = 3600;

/**
 * Assemble a sequence of Float32 LE PCM payloads into one Float32Array,
 * inserting `silenceSamples` zero samples between every consecutive pair
 * of chunks.
 *
 * Edge cases:
 *  - 0 chunks → empty Float32Array (length 0).
 *  - 1 chunk  → chunk's samples verbatim, no padding.
 *  - N chunks → exactly (N - 1) silence gaps interleaved.
 *  - An empty chunk (byteLength 0) still counts as a chunk: it contributes
 *    no samples but its silence boundary is still inserted, so callers
 *    can't smuggle gaps in by sending zero-length frames.
 */
export function assembleFloat32WithSilence(
  chunks: Uint8Array[],
  silenceSamples: number = INTER_CHUNK_SILENCE_SAMPLES
): Float32Array {
  if (chunks.length === 0) return new Float32Array(0);
  const padding = Math.max(0, silenceSamples);

  let totalSamples = 0;
  for (const c of chunks) {
    if (c.byteLength % 4 !== 0) {
      throw new Error(
        `assembleFloat32WithSilence: chunk byteLength=${c.byteLength} is not a multiple of 4`
      );
    }
    totalSamples += c.byteLength / 4;
  }
  totalSamples += padding * (chunks.length - 1);

  const out = new Float32Array(totalSamples);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.byteLength > 0) {
      const view = new Float32Array(c.buffer, c.byteOffset, c.byteLength / 4);
      out.set(view, offset);
      offset += view.length;
    }
    if (i < chunks.length - 1) {
      // Float32Array is zero-initialized; advancing the cursor by the
      // padding count IS the silence gap.
      offset += padding;
    }
  }
  return out;
}
