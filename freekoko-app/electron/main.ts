import os from 'node:os';
import path from 'node:path';
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import log from 'electron-log';

import { IPC } from '../shared/types';
import type {
  AppSettings,
  LogEntry,
  NavigatePayload,
  ServerStatus,
} from '../shared/types';
import { SidecarSupervisor } from './sidecar/SidecarSupervisor';
import { LogCapture } from './sidecar/LogCapture';
import { createSettingsStore, SettingsStore } from './store/SettingsStore';
import { TrayMenu } from './tray/TrayMenu';
import { registerIpcHandlers, unregisterIpcHandlers } from './ipc/handlers';
import { isCompatibleSystem, platformErrorMessage } from './platform';

app.setName('freekoko');

// Enforce single instance — any second launch focuses the main window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// -----------------------------------------------------------------------
// State (initialized in app.whenReady)
// -----------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let tray: TrayMenu | null = null;
let supervisor: SidecarSupervisor | null = null;
let settings: SettingsStore | null = null;
let logCapture: LogCapture | null = null;

// -----------------------------------------------------------------------
// Window factory
// -----------------------------------------------------------------------
export function getMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const devUrl = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5173';
  if (!app.isPackaged) {
    mainWindow.loadURL(devUrl).catch((err) => log.error('loadURL failed:', err));
  } else {
    mainWindow
      .loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
      .catch((err) => log.error('loadFile failed:', err));
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

export function showMainWindow(): void {
  const w = getMainWindow();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

export function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    const wc: WebContents = w.webContents;
    if (wc && !wc.isDestroyed()) {
      try {
        wc.send(channel, payload);
      } catch {
        /* ignore */
      }
    }
  }
}

// -----------------------------------------------------------------------
// Platform guard
// -----------------------------------------------------------------------
function ensurePlatformSupported(): boolean {
  const result = isCompatibleSystem(
    process.platform,
    process.arch,
    os.release()
  );
  if (result.ok) return true;
  const msg = platformErrorMessage(result);
  dialog.showErrorBox(msg.title, msg.detail);
  return false;
}

/**
 * Navigate the main window to a given tab (and optional section).
 * Broadcasts `on:navigate` — App.tsx listens via preload `onNavigate`.
 */
function navigate(payload: NavigatePayload): void {
  showMainWindow();
  broadcastToRenderer(IPC.ON_NAVIGATE, payload);
}

/**
 * Build the app-level menu. Keeps it minimal:
 *   - freekoko  → About / Settings… / Hide / Quit
 *   - Edit      → Undo/Redo/standard text editing (needed for TextArea)
 *   - Window    → Minimize / Zoom / Close
 * The tray remains the primary control surface per ARCHITECTURE §3.8.
 */
function buildAppMenu(): Menu {
  const appName = app.getName() || 'freekoko';
  const template: MenuItemConstructorOptions[] = [
    {
      label: appName,
      submenu: [
        {
          label: `About ${appName}`,
          click: () => navigate({ tab: 'settings', section: 'about' }),
        },
        { type: 'separator' },
        {
          label: 'Settings…',
          accelerator: 'Command+,',
          click: () => navigate({ tab: 'settings' }),
        },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

// -----------------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------------
app.whenReady().then(async () => {
  // Hide from Dock — menubar-first.
  app.dock?.hide();

  if (!ensurePlatformSupported()) {
    app.quit();
    return;
  }

  // Electron-log: rolling log files in app.getPath('logs').
  const logsDir = app.getPath('logs');
  log.transports.file.resolvePathFn = () =>
    path.join(logsDir, 'freekoko-main.log');
  log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB
  log.initialize?.({ preload: true });

  // Settings
  settings = await createSettingsStore(app.getPath('userData'));
  settings.on('changed', (newSettings: AppSettings) => {
    broadcastToRenderer(IPC.ON_SETTINGS_CHANGED, newSettings);
  });

  // Launch-at-login wiring. Apply persisted value on startup so that
  // if the user toggled it off via System Settings, we re-sync; likewise,
  // forward subsequent changes.
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.get('launchOnLogin'),
      path: process.execPath,
    });
  } catch (err) {
    log.warn('setLoginItemSettings (initial) failed:', err);
  }
  settings.on('changed', (s: AppSettings) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!s.launchOnLogin,
        path: process.execPath,
      });
    } catch (err) {
      log.warn('setLoginItemSettings failed:', err);
    }
  });

  // Sidecar log capture
  const sidecarLogFile = path.join(logsDir, 'freekoko-sidecar.log');
  const sidecarLog = log.create?.({ logId: 'sidecar' }) ?? log;
  try {
    sidecarLog.transports.file.resolvePathFn = () => sidecarLogFile;
    sidecarLog.transports.file.maxSize = 5 * 1024 * 1024;
  } catch {
    /* electron-log API differences between versions; best-effort */
  }
  logCapture = new LogCapture({
    onEntry: (entry: LogEntry) => {
      broadcastToRenderer(IPC.ON_LOG_LINE, entry);
    },
    fileAppender: (line: string) => {
      try {
        sidecarLog.info(line);
      } catch {
        /* ignore */
      }
    },
  });

  // Supervisor
  supervisor = new SidecarSupervisor({
    port: settings.get('port'),
    isPackaged: app.isPackaged,
    rootDir: __dirname,
    resourcesPath: process.resourcesPath,
    logCapture,
  });
  supervisor.on('status', (status: ServerStatus) => {
    broadcastToRenderer(IPC.ON_SERVER_STATUS, status);
    tray?.render(status);
  });

  // Settings → supervisor port sync
  settings.on('changed', (newSettings: AppSettings) => {
    if (supervisor && supervisor.status().port !== newSettings.port) {
      supervisor.setPort(newSettings.port);
    }
  });

  // Tray
  const trayResourcesDir = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', '..', 'resources', 'tray');
  tray = new TrayMenu(trayResourcesDir, {
    onStart: () => void supervisor?.start(),
    onStop: () => void supervisor?.stop({ graceful: true }),
    onRestart: () => void supervisor?.restart(),
    onRetry: () => void supervisor?.start(),
    onShowMain: () => navigate({ tab: 'generate' }),
    onShowSettings: () => navigate({ tab: 'settings' }),
    onShowLogs: () => navigate({ tab: 'logs' }),
    onShowAbout: () => navigate({ tab: 'settings', section: 'about' }),
    onQuit: () => app.quit(),
  });
  tray.init();
  tray.render(supervisor.status());

  // App-level menu (macOS only — lives above the screen).
  Menu.setApplicationMenu(buildAppMenu());

  // IPC
  registerIpcHandlers({
    supervisor,
    settings,
    logCapture,
    showMainWindow,
  });

  // Auto-start server?
  if (settings.get('autoStartServer')) {
    supervisor.start().catch((err) => {
      log.error('auto-start failed:', err);
    });
  }
});

// Second-instance: focus existing window.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Menubar-first: do NOT quit when all windows close.
// Electron fires this event and normally quits on all platforms except
// macOS — returning without calling app.quit() keeps the tray alive.
app.on('window-all-closed', () => {
  // Intentionally empty.
});

app.on('before-quit', async (event) => {
  if (!supervisor) return;
  if (supervisor.status().state === 'idle') return;
  event.preventDefault();
  try {
    await supervisor.stop({ graceful: true });
  } catch (err) {
    log.error('supervisor.stop failed during before-quit', err);
  } finally {
    unregisterIpcHandlers();
    // Allow the next quit to proceed without re-entering this handler.
    supervisor = null;
    setImmediate(() => app.quit());
  }
});

app.on('activate', () => {
  // Menubar-first: activate does not force-show the window.
  if (BrowserWindow.getAllWindows().length === 0) {
    // Only recreate if user explicitly requests via tray.
  }
});
