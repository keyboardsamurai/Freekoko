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
import type { NavigatePayload } from '@shared/types';

// The preload script shape (duplicated here intentionally — we cannot
// `import type` from electron/preload.ts because that pulls in Node
// types). If the shape diverges from preload, TypeScript will catch
// mismatches at runtime through the `window.electronAPI` reference.
interface ElectronAPI {
  supervisor: {
    start: () => Promise<ServerStatus>;
    stop: () => Promise<ServerStatus>;
    restart: () => Promise<ServerStatus>;
    status: () => Promise<ServerStatus>;
  };
  tts: {
    generate: (req: TtsRequest) => Promise<unknown>;
    voices: () => Promise<unknown>;
    health: () => Promise<unknown>;
  };
  history: {
    list: (arg?: { limit?: number; offset?: number }) => Promise<unknown>;
    get: (arg: { id: string }) => Promise<unknown>;
    delete: (arg: { id: string }) => Promise<unknown>;
    saveWav: (arg: { id: string; destPath?: string }) => Promise<unknown>;
    readWav: (arg: { id: string }) => Promise<unknown>;
    clear: (arg?: { confirmed: boolean }) => Promise<unknown>;
  };
  settings: {
    get: (key: keyof AppSettings) => Promise<unknown>;
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>;
    getAll: () => Promise<AppSettings>;
    chooseDirectory: (
      initial?: string
    ) => Promise<
      { ok: true; path: string } | { ok: false; cancelled?: boolean; error?: string }
    >;
    openPath: (target: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  logs: {
    recent: (limit?: number) => Promise<LogEntry[]>;
    clear: () => Promise<{ ok: true }>;
  };
  window: {
    showMain: () => Promise<{ ok: true }>;
  };
  app: {
    getVersion: () => Promise<string>;
    openUrl: (url: string) => Promise<unknown>;
  };
  onServerStatus: (cb: (status: ServerStatus) => void) => () => void;
  onLogLine: (cb: (entry: LogEntry) => void) => () => void;
  onSettingsChanged: (cb: (settings: AppSettings) => void) => () => void;
  onTtsProgress: (
    cb: (progress: TtsProgressEvent | TtsProgress) => void
  ) => () => void;
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

function isIpcError(v: unknown): v is IpcError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in (v as Record<string, unknown>)
  );
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
/** Returns TtsGenerateResult on success or IpcError on failure. */
export async function generateTTS(
  req: TtsRequest
): Promise<TtsGenerateResult | IpcError> {
  try {
    const res = await api().tts.generate(req);
    if (isIpcError(res)) return res;
    if (res && typeof res === 'object' && 'ok' in res) {
      return res as TtsGenerateResult;
    }
    return { error: 'unknown_response' };
  } catch (err) {
    return {
      error: 'ipc_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function listVoices(): Promise<VoiceInfo[]> {
  try {
    const res = await api().tts.voices();
    if (Array.isArray(res)) return res as VoiceInfo[];
    return [];
  } catch {
    return [];
  }
}

// --- History -----------------------------------------------------------
export async function listHistory(
  arg: { limit?: number; offset?: number } = {}
): Promise<HistoryItem[]> {
  const apiObj = (() => {
    try {
      return api();
    } catch {
      return null;
    }
  })();
  if (!apiObj) return [];
  try {
    const res = await apiObj.history.list(arg);
    if (Array.isArray(res)) return res as HistoryItem[];
    if (isIpcError(res)) return [];
    return [];
  } catch {
    return [];
  }
}

export async function deleteHistory(id: string): Promise<boolean> {
  try {
    const res = await api().history.delete({ id });
    if (isIpcError(res)) return false;
    if (typeof res === 'boolean') return res;
    if (res && typeof res === 'object' && 'ok' in res) {
      return !!(res as { ok: boolean }).ok;
    }
    return true;
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
    if (res && typeof res === 'object') {
      const o = res as { ok?: boolean; savedPath?: string; canceled?: boolean };
      return {
        ok: !!o.ok,
        savedPath: o.savedPath ? String(o.savedPath) : undefined,
        canceled: !!o.canceled,
      };
    }
    return { ok: !!res };
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
 * Read raw WAV bytes for a history entry. Returns `null` when the entry
 * is missing or the channel is unavailable.
 */
export async function readHistoryWav(id: string): Promise<Uint8Array | null> {
  const apiObj = (() => {
    try {
      return api();
    } catch {
      return null;
    }
  })();
  if (!apiObj) return null;
  try {
    const res = await apiObj.history.readWav({ id });
    if (isIpcError(res) || res == null) return null;
    if (res instanceof Uint8Array) return res;
    if (res instanceof ArrayBuffer) return new Uint8Array(res);
    if (Array.isArray(res)) return new Uint8Array(res as number[]);
    if (typeof res === 'object' && res !== null) {
      const obj = res as { bytes?: unknown; data?: unknown };
      const raw = obj.bytes ?? obj.data;
      if (raw instanceof Uint8Array) return raw;
      if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
      if (Array.isArray(raw)) return new Uint8Array(raw as number[]);
      // Some IPC bridges serialize buffers as { type: 'Buffer', data: [...] }.
      if (
        'type' in obj &&
        (obj as { type: unknown }).type === 'Buffer' &&
        'data' in obj
      ) {
        const data = (obj as { data: unknown }).data;
        if (Array.isArray(data)) return new Uint8Array(data as number[]);
      }
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
export const onNavigate = (cb: (payload: NavigatePayload) => void) =>
  api().onNavigate(cb);

export { isIpcError };
