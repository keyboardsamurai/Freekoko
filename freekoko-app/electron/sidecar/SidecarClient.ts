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
