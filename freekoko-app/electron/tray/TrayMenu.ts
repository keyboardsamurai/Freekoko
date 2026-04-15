import path from 'node:path';
import fs from 'node:fs';
import {
  Menu,
  Tray,
  nativeImage,
  app,
  type MenuItemConstructorOptions,
} from 'electron';

import type { ServerState, ServerStatus } from '../types';

export interface TrayMenuHandlers {
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onRetry: () => void;
  onShowMain: () => void;
  onShowSettings: () => void;
  onShowLogs: () => void;
  onShowAbout: () => void;
  onQuit: () => void;
}

/**
 * Compute the tray tooltip string for a given server status.
 * Exported so tests can assert it without instantiating a Tray.
 */
export function trayTooltip(status: ServerStatus): string {
  const { state, port } = status;
  switch (state) {
    case 'running':
      return `freekoko — running on :${port}`;
    case 'starting':
      return `freekoko — starting on :${port}…`;
    case 'stopping':
      return 'freekoko — stopping…';
    case 'idle':
      return 'freekoko — server stopped';
    case 'port_in_use':
      return `freekoko — port ${port} already in use`;
    case 'crashed':
      return `freekoko — sidecar crashed${
        status.errorMessage ? ` (${status.errorMessage})` : ''
      }`;
    case 'error':
      return `freekoko — error${
        status.errorMessage ? `: ${status.errorMessage}` : ''
      }`;
    default:
      return 'freekoko';
  }
}

/**
 * Pure function that computes the tray context menu template for a
 * given status. Exposed so unit tests can verify each state's
 * enable/disable wiring without instantiating a real Tray.
 *
 * Note: click handlers are inlined from the provided handler bundle;
 * tests verify the labels and `enabled` flags, not that clicks fire.
 */
export function buildTrayTemplate(
  status: ServerStatus,
  handlers: TrayMenuHandlers,
  appVersion = ''
): MenuItemConstructorOptions[] {
  const { state, port } = status;

  const openApp: MenuItemConstructorOptions = {
    label: 'Open freekoko',
    click: () => handlers.onShowMain(),
  };
  const openSettings: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'Command+,',
    click: () => handlers.onShowSettings(),
  };
  const openLogs: MenuItemConstructorOptions = {
    label: 'Logs',
    click: () => handlers.onShowLogs(),
  };
  const aboutItem: MenuItemConstructorOptions = {
    label: `About freekoko${appVersion ? ` ${appVersion}` : ''}`,
    click: () => handlers.onShowAbout(),
  };
  const quitItem: MenuItemConstructorOptions = {
    label: 'Quit freekoko',
    accelerator: 'Command+Q',
    click: () => handlers.onQuit(),
  };

  const startItem: MenuItemConstructorOptions = {
    label: 'Start Server',
    click: () => handlers.onStart(),
  };
  const stopItem: MenuItemConstructorOptions = {
    label: 'Stop Server',
    click: () => handlers.onStop(),
  };
  const restartItem: MenuItemConstructorOptions = {
    label: 'Restart Server',
    click: () => handlers.onRestart(),
  };
  const retryItem: MenuItemConstructorOptions = {
    label: 'Retry Start',
    click: () => handlers.onRetry(),
  };

  // Status header — always the first item, always disabled (just a label).
  let header: MenuItemConstructorOptions;

  if (state === 'running') {
    header = { label: `● Server running on :${port}`, enabled: false };
    return [
      header,
      { type: 'separator' },
      { ...startItem, enabled: false },
      { ...stopItem, enabled: true },
      { ...restartItem, enabled: true },
      { type: 'separator' },
      openApp,
      openLogs,
      openSettings,
      { type: 'separator' },
      aboutItem,
      quitItem,
    ];
  }

  if (state === 'starting') {
    header = { label: `● Starting on :${port}…`, enabled: false };
    return [
      header,
      { type: 'separator' },
      { ...startItem, enabled: false },
      { ...stopItem, enabled: true },
      { ...restartItem, enabled: false },
      { type: 'separator' },
      openApp,
      openLogs,
      openSettings,
      { type: 'separator' },
      aboutItem,
      quitItem,
    ];
  }

  if (state === 'stopping') {
    header = { label: '◐ Stopping…', enabled: false };
    return [
      header,
      { type: 'separator' },
      { ...startItem, enabled: false },
      { ...stopItem, enabled: false },
      { ...restartItem, enabled: false },
      { type: 'separator' },
      openApp,
      openLogs,
      openSettings,
      { type: 'separator' },
      aboutItem,
      quitItem,
    ];
  }

  if (state === 'port_in_use') {
    header = {
      label: `✕ Port ${port} in use — open Settings to change`,
      enabled: false,
    };
    return [
      header,
      { type: 'separator' },
      { ...retryItem, enabled: true },
      { type: 'separator' },
      openApp,
      openLogs,
      openSettings,
      { type: 'separator' },
      aboutItem,
      quitItem,
    ];
  }

  if (state === 'crashed' || state === 'error') {
    const msg =
      status.errorMessage ??
      (state === 'crashed' ? 'Sidecar crashed' : 'Unknown error');
    header = { label: `✕ ${msg}`, enabled: false };
    return [
      header,
      { type: 'separator' },
      { ...retryItem, enabled: true },
      { type: 'separator' },
      openApp,
      openLogs,
      openSettings,
      { type: 'separator' },
      aboutItem,
      quitItem,
    ];
  }

  // idle (server stopped)
  header = { label: '○ Server stopped', enabled: false };
  return [
    header,
    { type: 'separator' },
    { ...startItem, enabled: true },
    { ...stopItem, enabled: false },
    { ...restartItem, enabled: false },
    { type: 'separator' },
    openApp,
    openLogs,
    openSettings,
    { type: 'separator' },
    aboutItem,
    quitItem,
  ];
}

export class TrayMenu {
  private tray: Tray | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private lastStatus: ServerStatus | null = null;
  private resourcesDir: string;
  private handlers: TrayMenuHandlers;

  constructor(resourcesDir: string, handlers: TrayMenuHandlers) {
    this.resourcesDir = resourcesDir;
    this.handlers = handlers;
  }

  init(): void {
    const image = this.iconFor('idle');
    const tray = new Tray(image);
    tray.setToolTip('freekoko — server stopped');
    // Menubar-only — never show the main window on single click.
    this.tray = tray;
    this.render({ state: 'idle', port: 5002 });
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  render(status: ServerStatus): void {
    if (!this.tray) return;
    this.lastStatus = status;
    this.tray.setImage(this.iconFor(status.state));
    this.tray.setToolTip(trayTooltip(status));
    const template = buildTrayTemplate(
      status,
      this.handlers,
      app.getVersion?.() ?? ''
    );
    const menu = Menu.buildFromTemplate(template);
    this.tray.setContextMenu(menu);
  }

  // --- Build helpers -----------------------------------------------------

  private iconFor(state: ServerState): Electron.NativeImage {
    // Only three PNGs shipped today: idle / running / error.
    // starting borrows the idle glyph; stopping borrows running.
    const map: Record<ServerState, string> = {
      idle: 'tray-idle.png',
      starting: 'tray-idle.png',
      running: 'tray-running.png',
      stopping: 'tray-running.png',
      crashed: 'tray-error.png',
      port_in_use: 'tray-error.png',
      error: 'tray-error.png',
    };
    const file = map[state] ?? 'tray-idle.png';
    const p = path.join(this.resourcesDir, file);
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        // Template image so macOS inverts it correctly for dark/light menubar.
        img.setTemplateImage(true);
        return img;
      }
    } catch {
      /* fall through */
    }
    return nativeImage.createEmpty();
  }
}
