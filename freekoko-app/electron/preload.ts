import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  type AppOpenUrlResult,
  type AppSettings,
  type HistoryClearResult,
  type HistoryDeleteResult,
  type HistoryGetResult,
  type HistoryItem,
  type HistoryReadWavResult,
  type HistorySaveWavResult,
  type IpcError,
  type LogEntry,
  type NavigatePayload,
  type OkResult,
  type ServerStatus,
  type SettingsChooseDirectoryResult,
  type SettingsOpenPathResult,
  type TtsAbortResult,
  type TtsChunkEvent,
  type TtsDoneEvent,
  type TtsErrorEvent,
  type TtsGenerateResult,
  type TtsProgress,
  type TtsProgressEvent,
  type TtsRequest,
  type VoiceInfo,
} from '../shared/types';

// Narrow helper: ipcRenderer.on returns void; we wrap to give renderer
// code a clean unsubscribe function.
function subscribe<T>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  const wrapper = (_evt: unknown, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapper);
  return () => ipcRenderer.removeListener(channel, wrapper);
}

const electronAPI = {
  supervisor: {
    start: (): Promise<ServerStatus> => ipcRenderer.invoke(IPC.SUPERVISOR_START),
    stop: (): Promise<ServerStatus> => ipcRenderer.invoke(IPC.SUPERVISOR_STOP),
    restart: (): Promise<ServerStatus> =>
      ipcRenderer.invoke(IPC.SUPERVISOR_RESTART),
    status: (): Promise<ServerStatus> =>
      ipcRenderer.invoke(IPC.SUPERVISOR_STATUS),
  },
  tts: {
    generate: (req: TtsRequest): Promise<TtsGenerateResult | IpcError> =>
      ipcRenderer.invoke(IPC.TTS_GENERATE, req),
    generateStream: (
      req: TtsRequest
    ): Promise<{ requestId: string } | IpcError> =>
      ipcRenderer.invoke(IPC.TTS_GENERATE_STREAM, req),
    abort: (requestId: string): Promise<TtsAbortResult | IpcError> =>
      ipcRenderer.invoke(IPC.TTS_ABORT, { requestId }),
    voices: (): Promise<VoiceInfo[] | IpcError> =>
      ipcRenderer.invoke(IPC.TTS_VOICES),
  },
  history: {
    list: (
      arg: { limit?: number; offset?: number } = {}
    ): Promise<HistoryItem[] | IpcError> =>
      ipcRenderer.invoke(IPC.HISTORY_LIST, arg),
    get: (arg: { id: string }): Promise<HistoryGetResult | IpcError> =>
      ipcRenderer.invoke(IPC.HISTORY_GET, arg),
    delete: (arg: { id: string }): Promise<HistoryDeleteResult | IpcError> =>
      ipcRenderer.invoke(IPC.HISTORY_DELETE, arg),
    saveWav: (
      arg: { id: string; destPath?: string }
    ): Promise<HistorySaveWavResult | IpcError> =>
      ipcRenderer.invoke(IPC.HISTORY_SAVE_WAV, arg),
    readWav: (
      arg: { id: string }
    ): Promise<HistoryReadWavResult | IpcError> =>
      ipcRenderer.invoke(IPC.HISTORY_READ_WAV, arg),
    clear: (
      arg: { confirmed: boolean } = { confirmed: false }
    ): Promise<HistoryClearResult | IpcError> =>
      ipcRenderer.invoke(IPC.HISTORY_CLEAR, arg),
  },
  settings: {
    get: (key: keyof AppSettings): Promise<AppSettings[keyof AppSettings]> =>
      ipcRenderer.invoke(IPC.SETTINGS_GET, key),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
    getAll: (): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.SETTINGS_GET_ALL),
    chooseDirectory: (
      initial?: string
    ): Promise<SettingsChooseDirectoryResult | IpcError> =>
      ipcRenderer.invoke(IPC.SETTINGS_CHOOSE_DIRECTORY, { initial }),
    openPath: (
      target: string
    ): Promise<SettingsOpenPathResult | IpcError> =>
      ipcRenderer.invoke(IPC.SETTINGS_OPEN_PATH, { target }),
  },
  logs: {
    recent: (limit = 500): Promise<LogEntry[]> =>
      ipcRenderer.invoke(IPC.LOGS_RECENT, { limit }),
    clear: (): Promise<OkResult> => ipcRenderer.invoke(IPC.LOGS_CLEAR),
  },
  window: {
    showMain: (): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.WINDOW_SHOW_MAIN),
  },
  app: {
    getVersion: (): Promise<string> =>
      ipcRenderer.invoke(IPC.APP_GET_VERSION),
    openUrl: (url: string): Promise<AppOpenUrlResult | IpcError> =>
      ipcRenderer.invoke(IPC.APP_OPEN_URL, { url }),
  },
  onServerStatus: (cb: (status: ServerStatus) => void) =>
    subscribe<ServerStatus>(IPC.ON_SERVER_STATUS, cb),
  onLogLine: (cb: (entry: LogEntry) => void) =>
    subscribe<LogEntry>(IPC.ON_LOG_LINE, cb),
  onSettingsChanged: (cb: (settings: AppSettings) => void) =>
    subscribe<AppSettings>(IPC.ON_SETTINGS_CHANGED, cb),
  onTtsProgress: (cb: (progress: TtsProgressEvent | TtsProgress) => void) =>
    subscribe<TtsProgressEvent | TtsProgress>(IPC.ON_TTS_PROGRESS, cb),
  onTtsChunk: (cb: (event: TtsChunkEvent) => void): (() => void) =>
    subscribe<TtsChunkEvent>(IPC.ON_TTS_CHUNK, cb),
  onTtsDone: (cb: (event: TtsDoneEvent) => void): (() => void) =>
    subscribe<TtsDoneEvent>(IPC.ON_TTS_DONE, cb),
  onTtsError: (cb: (event: TtsErrorEvent) => void): (() => void) =>
    subscribe<TtsErrorEvent>(IPC.ON_TTS_ERROR, cb),
  onNavigate: (cb: (payload: NavigatePayload) => void) =>
    subscribe<NavigatePayload>(IPC.ON_NAVIGATE, cb),
};

export type ElectronAPI = typeof electronAPI;
export type { HistoryItem };

try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (err) {
  // If context isolation is somehow off, surface the error loudly instead
  // of silently failing.
  console.error('preload: exposeInMainWorld failed', err);
}
