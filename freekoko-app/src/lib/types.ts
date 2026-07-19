// Renderer-side type re-exports. Kept in its own file so renderer
// imports never reach into Node / Electron modules directly.
export type {
  AppSettings,
  AudiobookJob,
  AudiobookProgressEvent,
  AudiobookResult,
  HealthResponse,
  HistoryItem,
  IpcError,
  LogEntry,
  LogLevel,
  ServerState,
  ServerStatus,
  TtsChunkEvent,
  TtsDoneEvent,
  TtsErrorEvent,
  TtsGenerateResult,
  TtsProgress,
  TtsProgressEvent,
  TtsRequest,
  TtsResult,
  VoiceInfo,
} from '@shared/types';
export { IPC } from '@shared/types';
