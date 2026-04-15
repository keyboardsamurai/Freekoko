import path from 'node:path';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log';

import type {
  AppSettings,
  HistoryItem,
  IpcError,
  TtsGenerateResult,
  TtsProgressEvent,
  TtsRequest,
  VoiceInfo,
} from '../types';
import { IPC } from '../types';
import type { SidecarSupervisor } from '../sidecar/SidecarSupervisor';
import type { SettingsStore } from '../store/SettingsStore';
import type { LogCapture } from '../sidecar/LogCapture';
import { SidecarHttpError, fetchTTS, fetchVoices } from '../sidecar/SidecarClient';
import { HistoryStore } from '../history/HistoryStore';

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

  ipcMain.handle(IPC.TTS_VOICES, async () => {
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
  });

  ipcMain.handle(IPC.TTS_HEALTH, async () => {
    // Health itself is real so the status badge can work; we just proxy the supervisor.
    return supervisor.status();
  });

  // --- History ---------------------------------------------------------
  ipcMain.handle(
    IPC.HISTORY_LIST,
    async (_evt, arg?: { limit?: number; offset?: number }) => {
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

  ipcMain.handle(IPC.HISTORY_GET, async (_evt, arg: { id: string }) => {
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
  });

  ipcMain.handle(IPC.HISTORY_READ_WAV, async (_evt, arg: { id: string }) => {
    try {
      const id = String(arg?.id ?? '');
      if (!id) return { error: 'invalid_id' } satisfies IpcError;
      const buf = await history.readWav(id);
      if (!buf) return { error: 'not_found' } satisfies IpcError;
      // Electron serializes Buffer as Uint8Array over IPC; renderer
      // rebuilds a Blob from it.
      return { ok: true, bytes: new Uint8Array(buf) };
    } catch (err) {
      log.error('history:read-wav failed', err);
      return wrapError(err, 'history_read_failed');
    }
  });

  ipcMain.handle(IPC.HISTORY_DELETE, async (_evt, arg: { id: string }) => {
    try {
      const id = String(arg?.id ?? '');
      if (!id) return { error: 'invalid_id' } satisfies IpcError;
      const removed = await history.delete(id);
      return { ok: true, removed };
    } catch (err) {
      log.error('history:delete failed', err);
      return wrapError(err, 'history_delete_failed');
    }
  });

  ipcMain.handle(
    IPC.HISTORY_SAVE_WAV,
    async (_evt, arg: { id: string; destPath?: string }) => {
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
            return { ok: false, canceled: true };
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
    async (_evt, arg?: { confirmed?: boolean }) => {
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
    async (_evt, arg?: { initial?: string }) => {
      try {
        const initial = arg?.initial && typeof arg.initial === 'string' ? arg.initial : undefined;
        const res = await dialog.showOpenDialog({
          title: 'Choose output folder',
          defaultPath: initial,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (res.canceled || !res.filePaths?.[0]) {
          return { ok: false, cancelled: true } as const;
        }
        return { ok: true, path: res.filePaths[0] } as const;
      } catch (err) {
        log.error('settings:choose-directory failed', err);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as const;
      }
    }
  );
  ipcMain.handle(
    IPC.SETTINGS_OPEN_PATH,
    async (_evt, arg?: { target?: string }) => {
      const target = arg?.target && typeof arg.target === 'string' ? arg.target : '';
      if (!target) {
        return { ok: false, error: 'invalid_path' } as const;
      }
      try {
        const msg = await shell.openPath(target);
        // shell.openPath returns '' on success, otherwise an error string.
        if (msg) return { ok: false, error: msg } as const;
        return { ok: true } as const;
      } catch (err) {
        log.error('settings:open-path failed', err);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        } as const;
      }
    }
  );
  // --- Logs ------------------------------------------------------------
  ipcMain.handle(IPC.LOGS_RECENT, async (_evt, arg?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(arg?.limit ?? 500, 1000));
    return logCapture.recent(limit);
  });
  ipcMain.handle(IPC.LOGS_CLEAR, async () => {
    logCapture.clear();
    return { ok: true };
  });

  // --- Window / App ----------------------------------------------------
  ipcMain.handle(IPC.WINDOW_SHOW_MAIN, async () => {
    showMainWindow();
    return { ok: true };
  });
  ipcMain.handle(IPC.APP_GET_VERSION, async () => {
    return app.getVersion();
  });
  ipcMain.handle(IPC.APP_OPEN_URL, async (_evt, arg: { url: string }) => {
    const url = arg?.url ?? '';
    if (!/^https?:\/\//i.test(url)) {
      return { error: 'invalid_url' } satisfies IpcError;
    }
    await shell.openExternal(url);
    return { ok: true };
  });
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
