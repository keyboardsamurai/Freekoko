// Typed wrappers around window.electronAPI. Renderer components should
// import from here rather than reaching through `window.electronAPI`
// directly — this isolates the contextBridge surface in one place.

import type {
  AppSettings,
  HistoryItem,
  IpcError,
  LogEntry,
  ServerStatus,
  TtsGenerateResult,
  TtsProgress,
  TtsProgressEvent,
  TtsRequest,
  VoiceInfo,
} from './types';
import type {
  AppOpenUrlResult,
  HistoryClearResult,
  HistoryDeleteResult,
  HistoryGetResult,
  HistoryReadWavResult,
  HistorySaveWavResult,
  NavigatePayload,
  OkResult,
  SettingsChooseDirectoryResult,
  SettingsOpenPathResult,
  TtsAbortResult,
  TtsChunkEvent,
  TtsDoneEvent,
  TtsErrorEvent,
} from '@shared/types';

// The preload script shape (duplicated here intentionally — we cannot
// `import type` from electron/preload.ts because that pulls in Node
// types). Each method below mirrors the precise return type defined in
// preload.ts so renderer code can branch via `isIpcError(res)` without
// blind casts.
interface ElectronAPI {
  supervisor: {
    start: () => Promise<ServerStatus>;
    stop: () => Promise<ServerStatus>;
    restart: () => Promise<ServerStatus>;
    status: () => Promise<ServerStatus>;
  };
  tts: {
    generate: (req: TtsRequest) => Promise<TtsGenerateResult | IpcError>;
    generateStream: (
      req: TtsRequest
    ) => Promise<{ requestId: string } | IpcError>;
    abort: (requestId: string) => Promise<TtsAbortResult | IpcError>;
    voices: () => Promise<VoiceInfo[] | IpcError>;
  };
  history: {
    list: (
      arg?: { limit?: number; offset?: number }
    ) => Promise<HistoryItem[] | IpcError>;
    get: (arg: { id: string }) => Promise<HistoryGetResult | IpcError>;
    delete: (arg: { id: string }) => Promise<HistoryDeleteResult | IpcError>;
    saveWav: (
      arg: { id: string; destPath?: string }
    ) => Promise<HistorySaveWavResult | IpcError>;
    readWav: (
      arg: { id: string }
    ) => Promise<HistoryReadWavResult | IpcError>;
    clear: (
      arg?: { confirmed: boolean }
    ) => Promise<HistoryClearResult | IpcError>;
  };
  settings: {
    get: (key: keyof AppSettings) => Promise<AppSettings[keyof AppSettings]>;
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>;
    getAll: () => Promise<AppSettings>;
    chooseDirectory: (
      initial?: string
    ) => Promise<SettingsChooseDirectoryResult | IpcError>;
    openPath: (
      target: string
    ) => Promise<SettingsOpenPathResult | IpcError>;
  };
  logs: {
    recent: (limit?: number) => Promise<LogEntry[]>;
    clear: () => Promise<OkResult>;
  };
  window: {
    showMain: () => Promise<OkResult>;
  };
  app: {
    getVersion: () => Promise<string>;
    openUrl: (url: string) => Promise<AppOpenUrlResult | IpcError>;
  };
  onServerStatus: (cb: (status: ServerStatus) => void) => () => void;
  onLogLine: (cb: (entry: LogEntry) => void) => () => void;
  onSettingsChanged: (cb: (settings: AppSettings) => void) => () => void;
  onTtsProgress: (
    cb: (progress: TtsProgressEvent | TtsProgress) => void
  ) => () => void;
  onTtsChunk: (cb: (event: TtsChunkEvent) => void) => () => void;
  onTtsDone: (cb: (event: TtsDoneEvent) => void) => () => void;
  onTtsError: (cb: (event: TtsErrorEvent) => void) => () => void;
  onNavigate: (cb: (payload: NavigatePayload) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

function api(): ElectronAPI {
  const w = window as unknown as { electronAPI?: ElectronAPI };
  if (!w.electronAPI) {
    throw new Error(
      'window.electronAPI is not available — preload did not run?'
    );
  }
  return w.electronAPI;
}

/**
 * Discriminator for the canonical IPC failure shape `{ error: string,
 * message?: string }`. Every wrapper below uses this — no wrapper should
 * silently coerce a failure to a default value (empty array, null, etc.)
 * unless explicitly documented as "ignore failures" with a justification.
 */
function isIpcError(v: unknown): v is IpcError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in (v as Record<string, unknown>) &&
    typeof (v as { error: unknown }).error === 'string'
  );
}

/**
 * Minimal runtime boundary guard. TypeScript's preload typings are erased at
 * runtime, so any success-branch shape-check here must be performed on actual
 * values. Returns `true` when `obj` is a non-null object and every key in
 * `keys` is present (own-or-inherited) — no deep inspection of values.
 */
function hasShape(obj: unknown, keys: readonly string[]): obj is Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (!(k in rec)) return false;
  }
  return true;
}

/** Non-empty string helper for boundary shape checks. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// --- Supervisor --------------------------------------------------------
export const startServer = () => api().supervisor.start();
export const stopServer = () => api().supervisor.stop();
export const restartServer = () => api().supervisor.restart();
export const serverStatus = () => api().supervisor.status();

// --- Settings ----------------------------------------------------------
export const getAllSettings = () => api().settings.getAll();
export const setSettings = (patch: Partial<AppSettings>) =>
  api().settings.set(patch);
export const chooseDirectory = (initial?: string) =>
  api().settings.chooseDirectory(initial);
export const openPath = (target: string) => api().settings.openPath(target);

// --- Logs --------------------------------------------------------------
export const recentLogs = (limit = 500) => api().logs.recent(limit);
export const clearLogs = () => api().logs.clear();

// --- TTS ---------------------------------------------------------------
/** Returns `TtsGenerateResult` on success or `IpcError` on failure. */
export async function generateTTS(
  req: TtsRequest
): Promise<TtsGenerateResult | IpcError> {
  try {
    const res = await api().tts.generate(req);
    if (isIpcError(res)) return res;
    // Runtime shape guard — TS typings don't hold across the preload
    // boundary. If the main process ever returns a malformed payload we
    // must surface it as an error, not let renderers (e.g. GenerateView,
    // HistoryStore) crash on a missing field.
    if (!hasShape(res, ['ok', 'item', 'wavPath'])) {
      return {
        error: 'unknown_response',
        message: 'tts.generate payload missing expected keys (ok, item, wavPath).',
      };
    }
    if (res.ok !== true) {
      return {
        error: 'unknown_response',
        message: 'tts.generate payload has ok !== true.',
      };
    }
    if (!isNonEmptyString(res.wavPath)) {
      return {
        error: 'unknown_response',
        message: 'tts.generate payload has missing or empty wavPath.',
      };
    }
    if (!hasShape(res.item, ['id', 'createdAt', 'wavFilename'])) {
      return {
        error: 'unknown_response',
        message: 'tts.generate payload has malformed item (missing id/createdAt/wavFilename).',
      };
    }
    return res as TtsGenerateResult;
  } catch (err) {
    return {
      error: 'ipc_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Begin a streaming TTS generation. On success, returns a `requestId`
 * used to filter subsequent `tts:chunk` / `tts:done` / `tts:error`
 * events and to abort. On failure (validation error from the main
 * process, IPC error, or malformed response) returns an `IpcError`.
 */
export async function generateTTSStream(
  req: TtsRequest
): Promise<{ requestId: string } | IpcError> {
  try {
    const res = await api().tts.generateStream(req);
    if (isIpcError(res)) return res;
    // Runtime shape guard — see generateTTS() above. Consumers read
    // `res.requestId` to correlate chunk/done/error events and to abort;
    // a missing or empty requestId would desync the renderer.
    if (!hasShape(res, ['requestId']) || !isNonEmptyString(res.requestId)) {
      return {
        error: 'unknown_response',
        message: 'tts.generateStream payload missing or empty requestId.',
      };
    }
    return { requestId: res.requestId };
  } catch (err) {
    return {
      error: 'ipc_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Abort an in-flight streaming generation. Resolves once the main process
 * acknowledges the cancellation request — the actual audio cutoff arrives
 * shortly after via a `tts:done` (with `partial: true`, if at least one
 * chunk had arrived) or `tts:error` (code `'aborted'`, if no chunk
 * arrived) event. Returns the abort ack or `IpcError` (e.g., when the
 * request id was empty).
 */
export async function abortTTS(
  requestId: string
): Promise<TtsAbortResult | IpcError> {
  try {
    return await api().tts.abort(requestId);
  } catch (err) {
    return {
      error: 'ipc_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch the available voices. Returns the voice list on success or an
 * `IpcError` on failure. Empty list (`[]`) is a legitimate, distinct
 * outcome — it means the sidecar reported zero voices, NOT that the
 * call failed. Callers must surface error states (e.g., banner) instead
 * of treating failure as empty.
 */
export async function listVoices(): Promise<VoiceInfo[] | IpcError> {
  try {
    const res = await api().tts.voices();
    if (isIpcError(res)) return res;
    if (Array.isArray(res)) return res;
    return { error: 'unknown_response', message: 'Voices payload was not an array.' };
  } catch (err) {
    return {
      error: 'ipc_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- History -----------------------------------------------------------
/**
 * List history entries. Returns the array on success or `IpcError` on
 * failure. Callers MUST distinguish — silently returning `[]` for
 * failures hides sidecar/persistence outages from the user.
 */
export async function listHistory(
  arg: { limit?: number; offset?: number } = {}
): Promise<HistoryItem[] | IpcError> {
  try {
    const res = await api().history.list(arg);
    if (isIpcError(res)) return res;
    if (Array.isArray(res)) return res;
    return { error: 'unknown_response', message: 'History payload was not an array.' };
  } catch (err) {
    return {
      error: 'ipc_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteHistory(id: string): Promise<boolean> {
  try {
    const res = await api().history.delete({ id });
    if (isIpcError(res)) return false;
    return res.ok && res.removed;
  } catch {
    return false;
  }
}

export async function saveHistoryWav(
  id: string,
  destPath?: string
): Promise<{ ok: boolean; savedPath?: string; canceled?: boolean }> {
  try {
    const res = await api().history.saveWav({ id, destPath });
    if (isIpcError(res)) return { ok: false };
    return {
      ok: res.ok,
      savedPath: res.savedPath,
      canceled: res.canceled,
    };
  } catch {
    return { ok: false };
  }
}

export async function clearHistory(
  confirmed = false
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await api().history.clear({ confirmed });
    if (isIpcError(res)) return { ok: false, error: res.error };
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Read raw WAV bytes for a history entry.
 *
 * Returns:
 *  - `Uint8Array` — success.
 *  - `null`       — entry not found OR the channel was unavailable.
 *
 * The main-process handler emits exactly one canonical shape on success
 * (`{ ok: true, bytes: Uint8Array }`) — there are no fallback
 * deserializations here, matching the round-trip test in
 * `src/lib/ipc.roundtrip.test.ts`.
 */
export async function readHistoryWav(id: string): Promise<Uint8Array | null> {
  let apiObj: ElectronAPI;
  try {
    apiObj = api();
  } catch {
    return null;
  }
  try {
    const res = await apiObj.history.readWav({ id });
    if (isIpcError(res)) return null;
    if (res && typeof res === 'object' && 'bytes' in res) {
      const bytes = res.bytes;
      // Electron structured-clone always lands a Buffer/Uint8Array as a
      // Uint8Array view in the renderer.
      if (bytes instanceof Uint8Array) return bytes;
    }
    return null;
  } catch {
    return null;
  }
}

// --- Window / App ------------------------------------------------------
export const showMainWindow = () => api().window.showMain();
export const getAppVersion = () => api().app.getVersion();
export const openUrl = (url: string) => api().app.openUrl(url);

// --- Event subscriptions ----------------------------------------------
export const onServerStatus = (cb: (status: ServerStatus) => void) =>
  api().onServerStatus(cb);
export const onLogLine = (cb: (entry: LogEntry) => void) =>
  api().onLogLine(cb);
export const onSettingsChanged = (cb: (settings: AppSettings) => void) =>
  api().onSettingsChanged(cb);
export const onTtsProgress = (
  cb: (progress: TtsProgressEvent | TtsProgress) => void
) => api().onTtsProgress(cb);
export const onTtsChunk = (cb: (event: TtsChunkEvent) => void) =>
  api().onTtsChunk(cb);
export const onTtsDone = (cb: (event: TtsDoneEvent) => void) =>
  api().onTtsDone(cb);
export const onTtsError = (cb: (event: TtsErrorEvent) => void) =>
  api().onTtsError(cb);
export const onNavigate = (cb: (payload: NavigatePayload) => void) =>
  api().onNavigate(cb);

export { isIpcError };
