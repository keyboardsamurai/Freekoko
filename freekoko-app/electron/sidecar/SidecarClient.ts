import type { HealthResponse, TtsRequest, VoiceInfo } from '../types';

const DEFAULT_HEALTH_TIMEOUT_MS = 1_500;
const DEFAULT_VOICES_TIMEOUT_MS = 3_000;
const DEFAULT_TTS_TIMEOUT_MS = 120_000;

function timedAbort(timeoutMs: number): {
  controller: AbortController;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
    (timer as unknown as { unref: () => void }).unref();
  }
  return { controller, cancel: () => clearTimeout(timer) };
}

/**
 * Error thrown by sidecar HTTP calls. Carries the parsed error JSON
 * (if any) so callers can branch on `error` codes like `voice_not_found`.
 */
export class SidecarHttpError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(message: string, opts: { code: string; status: number; details?: unknown }) {
    super(message);
    this.name = 'SidecarHttpError';
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
  }
}

export async function fetchHealth(
  port: number,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS
): Promise<HealthResponse> {
  const { controller, cancel } = timedAbort(timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok && res.status !== 503) {
      throw new Error(`health_unexpected_status_${res.status}`);
    }
    const json = (await res.json()) as HealthResponse;
    return json;
  } finally {
    cancel();
  }
}

export async function fetchVoices(
  port: number,
  timeoutMs = DEFAULT_VOICES_TIMEOUT_MS
): Promise<VoiceInfo[]> {
  const { controller, cancel } = timedAbort(timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/voices`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new SidecarHttpError(errJson.message ?? `voices_status_${res.status}`, {
        code: errJson.error ?? 'voices_failed',
        status: res.status,
      });
    }
    const json = (await res.json()) as unknown;
    // Sidecar returns a flat array; tolerate a legacy `{voices, total}` shape too.
    const arr: unknown = Array.isArray(json)
      ? json
      : (json as { voices?: unknown }).voices ?? [];
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeVoice).filter((v): v is VoiceInfo => v != null);
  } finally {
    cancel();
  }
}

function normalizeVoice(raw: unknown): VoiceInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : null;
  const name = typeof o.name === 'string' ? o.name : null;
  const language = typeof o.language === 'string' ? o.language : null;
  const gender =
    o.gender === 'Female' || o.gender === 'Male' ? (o.gender as 'Female' | 'Male') : null;
  const quality = o.quality === 'A' || o.quality === 'B' ? (o.quality as 'A' | 'B') : null;
  if (!id || !name || !language || !gender || !quality) return null;
  const languageName =
    typeof o.languageName === 'string' ? o.languageName : languageDisplayName(language);
  return { id, name, language, languageName, gender, quality };
}

const LANG_DISPLAY: Record<string, string> = {
  'en-US': 'American English',
  'en-GB': 'British English',
  'es-ES': 'Spanish (Spain)',
  'it-IT': 'Italian',
  'pt-BR': 'Portuguese (Brazil)',
  'fr-FR': 'French',
  'de-DE': 'German',
  'ja-JP': 'Japanese',
  'zh-CN': 'Chinese (Simplified)',
};

function languageDisplayName(lang: string): string {
  return LANG_DISPLAY[lang] ?? lang;
}

export interface FetchTtsResult {
  wavBuffer: Buffer;
  contentType: string;
  /** HTTP round-trip wall time measured on the client. */
  durationMs: number;
  /** Sample count reported by the server (mono @ 24 kHz). Best-effort. */
  sampleCount: number;
  /** Voice actually used (echoed by server). */
  voice: string;
}

export interface FetchTtsOptions {
  timeoutMs?: number;
}

/**
 * Calls POST /tts. Returns the raw WAV bytes plus headers reported by the
 * server. Throws `SidecarHttpError` on non-2xx responses so the IPC layer
 * can turn `voice_not_found` / `text_too_long` etc. into user-facing errors.
 */
export async function fetchTTS(
  port: number,
  req: TtsRequest,
  opts: FetchTtsOptions = {}
): Promise<FetchTtsResult> {
  const started = Date.now();
  const { controller, cancel } = timedAbort(opts.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/tts`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        details?: unknown;
      };
      throw new SidecarHttpError(errJson.message ?? res.statusText, {
        code: errJson.error ?? 'unknown',
        status: res.status,
        details: errJson.details,
      });
    }
    const ab = await res.arrayBuffer();
    const wavBuffer = Buffer.from(ab);
    const durationMs = Number(res.headers.get('x-freekoko-duration-ms') ?? '0') ||
      (Date.now() - started);
    const sampleCount = Number(res.headers.get('x-freekoko-sample-count') ?? '0');
    const voice = res.headers.get('x-freekoko-voice') ?? req.voice;
    return {
      wavBuffer,
      contentType: res.headers.get('content-type') ?? 'audio/wav',
      durationMs,
      sampleCount,
      voice,
    };
  } finally {
    cancel();
  }
}

// ---------------------------------------------------------------------------
// Streaming TTS — POST /tts/stream
// ---------------------------------------------------------------------------

/**
 * One PCM frame parsed off the wire. `pcm` is the raw Float32 LE byte
 * payload (length is always a multiple of 4). The chunk index is
 * 0-based; total chunks comes from the preamble.
 */
export interface StreamFrame {
  chunkIndex: number;
  totalChunks: number;
  sampleRate: number;
  pcm: Uint8Array;
}

export interface StreamResult {
  sampleRate: number;
  totalChunks: number;
  /**
   * The raw PCM payloads of every chunk that made it across the wire,
   * in `chunkIndex` order. Element `i` is the bytes from frame `i`.
   * Length may be < `totalChunks` if the stream was aborted between
   * frames (the consumer is responsible for noting that).
   */
  chunks: Uint8Array[];
}

const STREAM_MAGIC = Buffer.from('FKST', 'ascii');
const PREAMBLE_BYTES = 16;
const FRAME_HEADER_BYTES = 8;

/**
 * State machine that turns a stream of arbitrary-sized byte chunks into
 * `StreamFrame` events. Tolerates split boundaries: the preamble may be
 * split across reads, the 8-byte frame header may be split, and the PCM
 * payload may be chunked mid-sample. Buffer is carried over between
 * `push()` calls; `flush()` returns whatever is left for end-of-stream
 * sanity checks.
 */
export class StreamFrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'awaiting_preamble' | 'awaiting_frame_header' | 'awaiting_pcm' =
    'awaiting_preamble';
  private sampleRate = 0;
  private totalChunks = 0;
  private currentChunkIndex = 0;
  private currentPcmLen = 0;

  push(chunk: Uint8Array, onFrame: (f: StreamFrame) => void): void {
    if (chunk.byteLength > 0) {
      this.buf = this.buf.length === 0
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.concat([this.buf, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
    }
    // Drain as many frames as the buffer allows. Each iteration must
    // either consume bytes (advance state) or break (need more data).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.state === 'awaiting_preamble') {
        if (this.buf.length < PREAMBLE_BYTES) return;
        if (this.buf.subarray(0, 4).compare(STREAM_MAGIC) !== 0) {
          throw new Error('stream_bad_magic');
        }
        this.sampleRate = this.buf.readUInt32BE(4);
        this.totalChunks = this.buf.readUInt32BE(8);
        // bytes 12..16 reserved
        this.buf = this.buf.subarray(PREAMBLE_BYTES);
        this.state = 'awaiting_frame_header';
        continue;
      }
      if (this.state === 'awaiting_frame_header') {
        if (this.buf.length < FRAME_HEADER_BYTES) return;
        this.currentChunkIndex = this.buf.readUInt32BE(0);
        this.currentPcmLen = this.buf.readUInt32BE(4);
        this.buf = this.buf.subarray(FRAME_HEADER_BYTES);
        this.state = 'awaiting_pcm';
        continue;
      }
      // awaiting_pcm
      if (this.buf.length < this.currentPcmLen) return;
      const pcmBuf = this.buf.subarray(0, this.currentPcmLen);
      // Hand the renderer a Uint8Array view over its own backing memory
      // (so structured-clone copies just the frame's bytes, not the
      // entire rolling buffer). `Buffer` IS a `Uint8Array` but we
      // explicitly construct a tight view to make that intent clear.
      const pcm = new Uint8Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.byteLength);
      // Detach the consumed slice from the rolling buffer.
      const tail = this.buf.subarray(this.currentPcmLen);
      this.buf = Buffer.from(tail);
      onFrame({
        chunkIndex: this.currentChunkIndex,
        totalChunks: this.totalChunks,
        sampleRate: this.sampleRate,
        pcm,
      });
      this.state = 'awaiting_frame_header';
      this.currentPcmLen = 0;
    }
  }

  /** True once the preamble has been fully consumed. */
  get hasPreamble(): boolean {
    return this.state !== 'awaiting_preamble';
  }

  get preambleSampleRate(): number {
    return this.sampleRate;
  }

  get preambleTotalChunks(): number {
    return this.totalChunks;
  }

  /** Returns the leftover bytes — should be zero at clean EOF. */
  remainingBytes(): number {
    return this.buf.length;
  }
}

/**
 * Calls POST /tts/stream and incrementally parses the binary wire
 * protocol. `onFrame` fires once per chunk in arrival order. Resolves
 * with the assembled chunk list on EOF; rejects on abort, network
 * error, or non-2xx response (carrying the same `SidecarHttpError`
 * mapping as `fetchTTS`).
 */
export async function fetchTTSStream(
  port: number,
  req: TtsRequest,
  onFrame: (frame: StreamFrame) => void,
  signal: AbortSignal
): Promise<StreamResult> {
  const res = await fetch(`http://127.0.0.1:${port}/tts/stream`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/octet-stream',
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const errJson = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      details?: unknown;
    };
    throw new SidecarHttpError(errJson.message ?? res.statusText, {
      code: errJson.error ?? 'unknown',
      status: res.status,
      details: errJson.details,
    });
  }
  if (!res.body) {
    throw new Error('stream_no_body');
  }

  const reader = res.body.getReader();
  const parser = new StreamFrameParser();
  const chunks: Uint8Array[] = [];
  let lastSampleRate = 0;
  let lastTotalChunks = 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      parser.push(value, (frame) => {
        lastSampleRate = frame.sampleRate;
        lastTotalChunks = frame.totalChunks;
        // Place by index so callers see chunks in canonical order even
        // if the server ever interleaves (today it doesn't, but the
        // parser doesn't enforce that).
        chunks[frame.chunkIndex] = frame.pcm;
        onFrame(frame);
      });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  return {
    sampleRate: lastSampleRate || parser.preambleSampleRate,
    totalChunks: lastTotalChunks || parser.preambleTotalChunks,
    chunks,
  };
}
