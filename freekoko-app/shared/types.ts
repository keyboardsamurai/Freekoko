// Shared IPC / domain types. Single source of truth used by main, preload,
// and renderer. Imported via the `@shared/types` path alias.

export type ServerState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed'
  | 'port_in_use'
  | 'error';

export interface ServerStatus {
  state: ServerState;
  pid?: number;
  port: number;
  errorMessage?: string;
  startedAt?: string;
  uptimeSeconds?: number;
}

export interface TtsRequest {
  text: string;
  voice: string;
  speed: number;
}

export interface TtsResult {
  id: string;
  wavPath: string;
  durationMs: number;
  sampleCount: number;
  voice: string;
  textPreview: string;
}

export interface TtsProgress {
  chunkIndex: number;
  totalChunks: number;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  languageName: string;
  gender: 'Female' | 'Male';
  quality: 'A' | 'B';
}

export interface HealthResponse {
  status: 'ok' | 'loading' | 'error';
  model_loaded: boolean;
  voices_loaded: number;
  version: string;
  uptime_seconds: number;
  pid?: number;
}

export interface AppSettings {
  port: number;
  outputDir: string;
  defaultVoice: string;
  defaultSpeed: number;
  launchOnLogin: boolean;
  autoStartServer: boolean;
}

export interface HistoryItem {
  /** UUID v4 generated when the entry is persisted. */
  id: string;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** Full input text that was synthesized. */
  text: string;
  /** Voice ID used for synthesis. */
  voice: string;
  /** Playback speed used (0.5..2.0). */
  speed: number;
  /** Raw WAV sample count (mono @ 24 kHz). */
  sampleCount: number;
  /** Wall-clock duration the server took to synthesize. */
  durationMs: number;
  /** Filename (not path) of the WAV inside the history dir. */
  wavFilename: string;
  /** First 120 chars of `text`, used for list rendering. */
  previewText: string;
}

/** Result of a successful `tts:generate` IPC call. */
export interface TtsGenerateResult {
  ok: true;
  item: HistoryItem;
  wavPath: string;
}

/** Per-chunk progress event pushed on `on:tts-progress`. */
export interface TtsProgressEvent {
  phase: 'start' | 'chunk' | 'done';
  /** Total input length (characters) — set on 'start'. */
  textLength?: number;
  /** Current chunk index (0-based) — set on 'chunk'. */
  chunkIndex?: number;
  /** Total chunk count — set on 'chunk'. */
  totalChunks?: number;
  /** Resulting history item id — set on 'done'. */
  itemId?: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  event?: string;
  message?: string;
  [key: string]: unknown;
}

export interface IpcError {
  error: string;
  message?: string;
  phase?: string;
}

// --- IPC channel names -----------------------------------------------------

export const IPC = {
  // Supervisor
  SUPERVISOR_START: 'supervisor:start',
  SUPERVISOR_STOP: 'supervisor:stop',
  SUPERVISOR_RESTART: 'supervisor:restart',
  SUPERVISOR_STATUS: 'supervisor:status',

  // TTS
  TTS_GENERATE: 'tts:generate',
  TTS_VOICES: 'tts:voices',
  TTS_HEALTH: 'tts:health',

  // History
  HISTORY_LIST: 'history:list',
  HISTORY_GET: 'history:get',
  HISTORY_DELETE: 'history:delete',
  HISTORY_SAVE_WAV: 'history:save-wav',
  HISTORY_READ_WAV: 'history:read-wav',
  HISTORY_CLEAR: 'history:clear',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_CHOOSE_DIRECTORY: 'settings:choose-directory',
  SETTINGS_OPEN_PATH: 'settings:open-path',

  // Logs
  LOGS_RECENT: 'logs:recent',
  LOGS_CLEAR: 'logs:clear',

  // Window / App
  WINDOW_SHOW_MAIN: 'window:show-main',
  APP_GET_VERSION: 'app:get-version',
  APP_OPEN_URL: 'app:open-url',

  // Events (M → R)
  ON_SERVER_STATUS: 'on:server-status',
  ON_LOG_LINE: 'on:log-line',
  ON_SETTINGS_CHANGED: 'on:settings-changed',
  ON_TTS_PROGRESS: 'on:tts-progress',
  ON_NAVIGATE: 'on:navigate',
} as const;

/** Tabs the renderer knows about; used by the `on:navigate` push event. */
export type NavTab = 'generate' | 'history' | 'logs' | 'settings';

/** Payload for the `on:navigate` event emitted by the main process (tray + app menu). */
export interface NavigatePayload {
  tab: NavTab;
  /** Optional hint for the view to scroll into a named section (e.g. Settings 'about'). */
  section?: string;
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
