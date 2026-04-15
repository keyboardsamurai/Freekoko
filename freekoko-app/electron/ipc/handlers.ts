import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log';

import type {
  AppSettings,
  HistoryClearResult,
  HistoryDeleteResult,
  HistoryGetResult,
  HistoryItem,
  HistoryReadWavResult,
  HistorySaveWavResult,
  IpcError,
  OkResult,
  SettingsChooseDirectoryResult,
  SettingsOpenPathResult,
  TtsAbortResult,
  TtsChunkEvent,
  TtsDoneEvent,
  TtsErrorEvent,
  TtsGenerateResult,
  TtsProgressEvent,
  TtsRequest,
  VoiceInfo,
} from '../types';
import { IPC } from '../types';
import type { SidecarSupervisor } from '../sidecar/SidecarSupervisor';
import type { SettingsStore } from '../store/SettingsStore';
import type { LogCapture } from '../sidecar/LogCapture';
import {
  SidecarHttpError,
  fetchTTS,
  fetchTTSStream,
  fetchVoices,
} from '../sidecar/SidecarClient';
import { HistoryStore } from '../history/HistoryStore';
import { encodeWav } from '../history/wavEncode';
import {
  INTER_CHUNK_SILENCE_SAMPLES,
  assembleFloat32WithSilence,
} from '../audio/assembleFloat32WithSilence';

export interface HandlerDeps {
  supervisor: SidecarSupervisor;
  settings: SettingsStore;
  logCapture: LogCapture;
  showMainWindow: () => void;
  /** Optional override — tests inject an in-memory HistoryStore. */
  historyStore?: HistoryStore;
}

/** Broadcast a channel payload to every live renderer window. */
function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    const wc = w.webContents;
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send(channel, payload);
      } catch {
        /* ignore — renderer going away */
      }
    }
  }
}

function wrapError(err: unknown, fallback: string): IpcError {
  if (err instanceof SidecarHttpError) {
    return { error: err.code, message: err.message };
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return { error: 'timeout', message: err.message };
    }
    // Node fetch raises a TypeError with cause.code === 'ECONNREFUSED'
    // when the sidecar isn't listening yet.
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED') {
      return { error: 'sidecar_unreachable', message: err.message };
    }
    return { error: fallback, message: err.message };
  }
  return { error: fallback, message: String(err) };
}

export function registerIpcHandlers(deps: HandlerDeps): void {
  const { supervisor, settings, logCapture, showMainWindow } = deps;

  // HistoryStore is long-lived, created here so main.ts is untouched.
  const historyBaseDir = path.join(app.getPath('userData'), 'history');
  const history = deps.historyStore ?? new HistoryStore(historyBaseDir);
  // Fire-and-forget init; add() awaits init() internally too.
  void history.init().catch((err) => {
    log.error('HistoryStore init failed:', err);
  });

  // --- Supervisor ------------------------------------------------------
  ipcMain.handle(IPC.SUPERVISOR_START, async () => {
    return supervisor.start();
  });
  ipcMain.handle(IPC.SUPERVISOR_STOP, async () => {
    return supervisor.stop({ graceful: true });
  });
  ipcMain.handle(IPC.SUPERVISOR_RESTART, async () => {
    return supervisor.restart();
  });
  ipcMain.handle(IPC.SUPERVISOR_STATUS, async () => {
    return supervisor.status();
  });

  // --- TTS -------------------------------------------------------------
  ipcMain.handle(IPC.TTS_GENERATE, async (_evt, arg: TtsRequest) => {
    const status = supervisor.status();
    if (status.state !== 'running') {
      return {
        error: 'server_not_running',
        message: `Server is ${status.state}; start it before generating.`,
      } satisfies IpcError;
    }

    const req: TtsRequest = {
      text: String(arg?.text ?? ''),
      voice: String(arg?.voice ?? settings.get('defaultVoice')),
      speed: Number(arg?.speed ?? settings.get('defaultSpeed')),
    };
    if (!req.text.trim()) {
      return { error: 'text_empty', message: 'Text is empty.' } satisfies IpcError;
    }
    if (req.text.length > 8000) {
      return {
        error: 'text_too_long',
        message: 'Text exceeds 8000 characters.',
      } satisfies IpcError;
    }

    // Emit start progress.
    const startEvt: TtsProgressEvent = {
      phase: 'start',
      textLength: req.text.length,
    };
    broadcast(IPC.ON_TTS_PROGRESS, startEvt);

    try {
      const result = await fetchTTS(status.port, req);

      const item: HistoryItem = await history.add({
        text: req.text,
        voice: result.voice || req.voice,
        speed: req.speed,
        wavBuffer: result.wavBuffer,
        sampleCount: result.sampleCount,
        durationMs: result.durationMs,
      });

      // Emit done progress.
      const doneEvt: TtsProgressEvent = { phase: 'done', itemId: item.id };
      broadcast(IPC.ON_TTS_PROGRESS, doneEvt);

      const wavPath = path.join(history.dir, item.wavFilename);
      const payload: TtsGenerateResult = { ok: true, item, wavPath };
      return payload;
    } catch (err) {
      log.error('tts:generate failed', err);
      broadcast(IPC.ON_TTS_PROGRESS, { phase: 'done' } satisfies TtsProgressEvent);
      return wrapError(err, 'tts_failed');
    }
  });

  // --- Streaming TTS (`/tts/stream`) ---------------------------------
  // One AbortController per in-flight requestId. Cleared on completion,
  // abort, or error. Map is process-wide because aborts may arrive on a
  // different IPC frame than the originator.
  const streamAborts = new Map<string, AbortController>();

  ipcMain.handle(IPC.TTS_GENERATE_STREAM, async (evt, arg: TtsRequest) => {
    const status = supervisor.status();
    if (status.state !== 'running') {
      return {
        error: 'server_not_running',
        message: `Server is ${status.state}; start it before generating.`,
      } satisfies IpcError;
    }

    const req: TtsRequest = {
      text: String(arg?.text ?? ''),
      voice: String(arg?.voice ?? settings.get('defaultVoice')),
      speed: Number(arg?.speed ?? settings.get('defaultSpeed')),
    };
    if (!req.text.trim()) {
      return { error: 'text_empty', message: 'Text is empty.' } satisfies IpcError;
    }
    // Note: no `text_too_long` cap here — streaming removes the 8k limit.

    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    streamAborts.set(requestId, controller);
    const sender = evt.sender;
    const startedAt = Date.now();
    const port = status.port;

    // Kick off the stream on a background promise. Return immediately
    // so the renderer can wire up its event listeners and start the
    // AudioContext while data is in-flight.
    void (async () => {
      const receivedChunks: Uint8Array[] = [];
      let sampleRate = 0;
      let _totalChunks = 0;
      let firstError: { code: string; message: string } | null = null;

      const safeSend = (channel: string, payload: unknown) => {
        if (!sender || sender.isDestroyed()) return;
        try {
          sender.send(channel, payload);
        } catch {
          /* renderer went away mid-stream */
        }
      };

      try {
        const result = await fetchTTSStream(
          port,
          req,
          (frame) => {
            sampleRate = frame.sampleRate;
            _totalChunks = frame.totalChunks;
            receivedChunks[frame.chunkIndex] = frame.pcm;
            const evtPayload: TtsChunkEvent = {
              requestId,
              chunkIndex: frame.chunkIndex,
              totalChunks: frame.totalChunks,
              sampleRate: frame.sampleRate,
              pcm: frame.pcm,
            };
            safeSend(IPC.ON_TTS_CHUNK, evtPayload);
          },
          controller.signal
        );
        sampleRate = result.sampleRate || sampleRate;
        _totalChunks = result.totalChunks || _totalChunks;
      } catch (err) {
        if (err instanceof SidecarHttpError) {
          firstError = { code: err.code, message: err.message };
        } else if (err instanceof Error) {
          if (err.name === 'AbortError') {
            firstError = { code: 'aborted', message: 'Generation aborted.' };
          } else {
            const cause = (err as { cause?: { code?: string } }).cause;
            if (cause?.code === 'ECONNREFUSED') {
              firstError = {
                code: 'sidecar_unreachable',
                message: err.message,
              };
            } else {
              firstError = { code: 'tts_failed', message: err.message };
            }
          }
        } else {
          firstError = { code: 'tts_failed', message: String(err) };
        }
      } finally {
        streamAborts.delete(requestId);
      }

      // Compact the sparse `receivedChunks` array (in case any indices
      // are missing — they shouldn't be, but defend against it).
      const orderedChunks = receivedChunks.filter(
        (c): c is Uint8Array => c instanceof Uint8Array
      );

      const aborted = controller.signal.aborted;
      const hasAnyChunks = orderedChunks.length > 0;

      // Terminal-state priority:
      //   1. User abort (controller.signal.aborted): if any chunks arrived
      //      persist a partial WAV + fire tts:done{partial:true}; otherwise
      //      fire a silent tts:error{code:'aborted'}. User abort wins over
      //      any accompanying AbortError the fetch surfaces in `firstError`.
      //   2. Real (non-abort) failure: never persist. Fire tts:error with
      //      the original error code, even if some chunks had arrived —
      //      conflating sidecar crashes with intentional aborts hides bugs.
      //   3. Clean completion: persist full WAV + fire tts:done{partial:false}.
      if (aborted) {
        if (!hasAnyChunks) {
          safeSend(IPC.ON_TTS_ERROR, {
            requestId,
            code: 'aborted',
            message: 'Generation aborted before any audio.',
          } satisfies TtsErrorEvent);
          return;
        }
        // else fall through to persist the partial
      } else if (firstError) {
        safeSend(IPC.ON_TTS_ERROR, {
          requestId,
          code: firstError.code,
          message: firstError.message,
        } satisfies TtsErrorEvent);
        return;
      }

      // Clean completion OR user abort after ≥1 chunk.
      try {
        const float32 = assembleFloat32WithSilence(
          orderedChunks,
          INTER_CHUNK_SILENCE_SAMPLES
        );
        const wavBuffer = encodeWav(float32, sampleRate || 24000);
        const item: HistoryItem = await history.add({
          text: req.text,
          voice: req.voice,
          speed: req.speed,
          wavBuffer,
          sampleCount: float32.length,
          durationMs: Date.now() - startedAt,
          partial: aborted,
        });
        const wavPath = path.join(history.dir, item.wavFilename);
        const doneEvt: TtsDoneEvent = {
          requestId,
          item,
          wavPath,
          partial: aborted,
        };
        safeSend(IPC.ON_TTS_DONE, doneEvt);
      } catch (err) {
        log.error('tts:generate-stream finalize failed', err);
        const errEvt: TtsErrorEvent = {
          requestId,
          code: 'finalize_failed',
          message: err instanceof Error ? err.message : String(err),
        };
        safeSend(IPC.ON_TTS_ERROR, errEvt);
      }
    })();

    return { requestId };
  });

  ipcMain.handle(
    IPC.TTS_ABORT,
    async (_evt, arg: { requestId: string }): Promise<TtsAbortResult | IpcError> => {
      const id = String(arg?.requestId ?? '');
      if (!id) return { error: 'invalid_request_id' } satisfies IpcError;
      const ctrl = streamAborts.get(id);
      if (ctrl) {
        try {
          ctrl.abort();
        } catch {
          /* already aborted */
        }
        streamAborts.delete(id);
        return { ok: true };
      }
      return { ok: true, alreadyDone: true };
    }
  );

  ipcMain.handle(
    IPC.TTS_VOICES,
    async (): Promise<VoiceInfo[] | IpcError> => {
      const status = supervisor.status();
      if (status.state !== 'running') {
        return {
          error: 'server_not_running',
          message: `Server is ${status.state}.`,
        } satisfies IpcError;
      }
      try {
        const voices: VoiceInfo[] = await fetchVoices(status.port);
        return voices;
      } catch (err) {
        log.error('tts:voices failed', err);
        return wrapError(err, 'sidecar_unreachable');
      }
    }
  );

  // (TTS_HEALTH removed in IPC contract cleanup — no renderer callers.
  // The status badge subscribes to `on:server-status` for live state and
  // calls supervisor.status() directly when it needs an explicit poll.)

  // --- History ---------------------------------------------------------
  ipcMain.handle(
    IPC.HISTORY_LIST,
    async (
      _evt,
      arg?: { limit?: number; offset?: number }
    ): Promise<HistoryItem[] | IpcError> => {
      try {
        const limit = Math.max(1, Math.min(arg?.limit ?? 50, 500));
        const offset = Math.max(0, arg?.offset ?? 0);
        return await history.list(limit, offset);
      } catch (err) {
        log.error('history:list failed', err);
        return wrapError(err, 'history_list_failed');
      }
    }
  );

  ipcMain.handle(
    IPC.HISTORY_GET,
    async (_evt, arg: { id: string }): Promise<HistoryGetResult | IpcError> => {
      try {
        const id = String(arg?.id ?? '');
        if (!id) return { error: 'invalid_id' } satisfies IpcError;
        const hit = await history.get(id);
        if (!hit) return { error: 'not_found' } satisfies IpcError;
        return { item: hit.item, wavPath: hit.wavPath };
      } catch (err) {
        log.error('history:get failed', err);
        return wrapError(err, 'history_get_failed');
      }
    }
  );

  ipcMain.handle(
    IPC.HISTORY_READ_WAV,
    async (
      _evt,
      arg: { id: string }
    ): Promise<HistoryReadWavResult | IpcError> => {
      try {
        const id = String(arg?.id ?? '');
        if (!id) return { error: 'invalid_id' } satisfies IpcError;
        const buf = await history.readWav(id);
        if (!buf) return { error: 'not_found' } satisfies IpcError;
        // Electron serializes Buffer as Uint8Array over IPC. We hand the
        // renderer exactly one canonical shape — `{ok:true, bytes}` — so
        // the renderer never has to fall back through alternative
        // deserializations.
        return { ok: true, bytes: new Uint8Array(buf) };
      } catch (err) {
        log.error('history:read-wav failed', err);
        return wrapError(err, 'history_read_failed');
      }
    }
  );

  ipcMain.handle(
    IPC.HISTORY_DELETE,
    async (
      _evt,
      arg: { id: string }
    ): Promise<HistoryDeleteResult | IpcError> => {
      try {
        const id = String(arg?.id ?? '');
        if (!id) return { error: 'invalid_id' } satisfies IpcError;
        const removed = await history.delete(id);
        return { ok: true, removed };
      } catch (err) {
        log.error('history:delete failed', err);
        return wrapError(err, 'history_delete_failed');
      }
    }
  );

  ipcMain.handle(
    IPC.HISTORY_SAVE_WAV,
    async (
      _evt,
      arg: { id: string; destPath?: string }
    ): Promise<HistorySaveWavResult | IpcError> => {
      try {
        const id = String(arg?.id ?? '');
        if (!id) return { error: 'invalid_id' } satisfies IpcError;
        const hit = await history.get(id);
        if (!hit) return { error: 'not_found' } satisfies IpcError;

        let destPath = arg?.destPath ? String(arg.destPath) : '';
        if (!destPath) {
          const outputDir = settings.get('outputDir');
          const ts = hit.item.createdAt.replace(/[:.]/g, '-');
          const suggested = path.join(
            outputDir,
            `${hit.item.voice}_${ts}.wav`
          );
          const saveRes = await dialog.showSaveDialog({
            title: 'Save WAV',
            defaultPath: suggested,
            filters: [{ name: 'WAV audio', extensions: ['wav'] }],
          });
          if (saveRes.canceled || !saveRes.filePath) {
            // User dismissed the picker — not an error, but not a success
            // either. The renderer treats `canceled: true` as a no-op.
            return { ok: true, canceled: true };
          }
          destPath = saveRes.filePath;
        }

        const saved = await history.saveWavAs(id, destPath);
        if (!saved) return { error: 'not_found' } satisfies IpcError;
        return { ok: true, savedPath: saved };
      } catch (err) {
        log.error('history:save-wav failed', err);
        return wrapError(err, 'history_save_failed');
      }
    }
  );

  ipcMain.handle(
    IPC.HISTORY_CLEAR,
    async (
      _evt,
      arg?: { confirmed?: boolean }
    ): Promise<HistoryClearResult | IpcError> => {
      if (!arg?.confirmed) {
        return {
          error: 'confirmation_required',
          message: 'Pass { confirmed: true } to clear history.',
        } satisfies IpcError;
      }
      try {
        await history.clear();
        return { ok: true };
      } catch (err) {
        log.error('history:clear failed', err);
        return wrapError(err, 'history_clear_failed');
      }
    }
  );

  // --- Settings --------------------------------------------------------
  ipcMain.handle(
    IPC.SETTINGS_GET,
    async (_evt, key: keyof AppSettings) => {
      return settings.get(key);
    }
  );
  ipcMain.handle(
    IPC.SETTINGS_SET,
    async (_evt, patch: Partial<AppSettings>) => {
      return settings.setMany(patch ?? {});
    }
  );
  ipcMain.handle(IPC.SETTINGS_GET_ALL, async () => {
    return settings.getAll();
  });
  ipcMain.handle(
    IPC.SETTINGS_CHOOSE_DIRECTORY,
    async (
      _evt,
      arg?: { initial?: string }
    ): Promise<SettingsChooseDirectoryResult | IpcError> => {
      try {
        const initial = arg?.initial && typeof arg.initial === 'string' ? arg.initial : undefined;
        const res = await dialog.showOpenDialog({
          title: 'Choose output folder',
          defaultPath: initial,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (res.canceled || !res.filePaths?.[0]) {
          // User dismissed the picker — explicit `canceled: true` so the
          // renderer can distinguish from a real error.
          return { ok: false, canceled: true };
        }
        return { ok: true, path: res.filePaths[0] };
      } catch (err) {
        log.error('settings:choose-directory failed', err);
        return wrapError(err, 'choose_directory_failed');
      }
    }
  );
  ipcMain.handle(
    IPC.SETTINGS_OPEN_PATH,
    async (
      _evt,
      arg?: { target?: string }
    ): Promise<SettingsOpenPathResult | IpcError> => {
      const target = arg?.target && typeof arg.target === 'string' ? arg.target : '';
      if (!target) {
        return { error: 'invalid_path' } satisfies IpcError;
      }
      try {
        const msg = await shell.openPath(target);
        // shell.openPath returns '' on success, otherwise an error string.
        if (msg) return { error: 'open_path_failed', message: msg } satisfies IpcError;
        return { ok: true };
      } catch (err) {
        log.error('settings:open-path failed', err);
        return wrapError(err, 'open_path_failed');
      }
    }
  );
  // --- Logs ------------------------------------------------------------
  ipcMain.handle(IPC.LOGS_RECENT, async (_evt, arg?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(arg?.limit ?? 500, 1000));
    return logCapture.recent(limit);
  });
  ipcMain.handle(IPC.LOGS_CLEAR, async (): Promise<OkResult> => {
    logCapture.clear();
    return { ok: true };
  });

  // --- Window / App ----------------------------------------------------
  ipcMain.handle(IPC.WINDOW_SHOW_MAIN, async (): Promise<OkResult> => {
    showMainWindow();
    return { ok: true };
  });
  ipcMain.handle(IPC.APP_GET_VERSION, async () => {
    return app.getVersion();
  });
  ipcMain.handle(
    IPC.APP_OPEN_URL,
    async (_evt, arg: { url: string }): Promise<OkResult | IpcError> => {
      const url = arg?.url ?? '';
      if (!/^https?:\/\//i.test(url)) {
        return { error: 'invalid_url' } satisfies IpcError;
      }
      await shell.openExternal(url);
      return { ok: true };
    }
  );
}

export function unregisterIpcHandlers(): void {
  const channels = Object.values(IPC).filter((c) => !c.startsWith('on:'));
  for (const ch of channels) {
    try {
      ipcMain.removeHandler(ch);
    } catch {
      /* already gone */
    }
  }
}
