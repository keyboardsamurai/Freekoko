import { describe, expect, it, vi } from 'vitest';

// TrayMenu imports from 'electron' (Menu, Tray, nativeImage, app). The pure
// template builder we test (`buildTrayTemplate`) only uses types, but the
// module-level imports still have to resolve. Provide a minimal mock.
vi.mock('electron', () => {
  class NativeImage {
    setTemplateImage() {
      /* no-op */
    }
  }
  return {
    Menu: {
      buildFromTemplate: (t: unknown) => t,
    },
    Tray: class {},
    nativeImage: {
      createFromPath: () => new NativeImage(),
      createEmpty: () => new NativeImage(),
    },
    app: {
      getVersion: () => '0.1.0',
    },
  };
});

import type { ServerStatus } from '../types';
import {
  buildTrayTemplate,
  trayTooltip,
  type TrayMenuHandlers,
} from './TrayMenu';

function makeHandlers(): TrayMenuHandlers {
  return {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRestart: vi.fn(),
    onRetry: vi.fn(),
    onShowMain: vi.fn(),
    onShowSettings: vi.fn(),
    onShowLogs: vi.fn(),
    onShowAbout: vi.fn(),
    onQuit: vi.fn(),
  };
}

type Item = { label?: string; enabled?: boolean; type?: string };

function findByLabelStart(
  items: Item[],
  prefix: string
): Item | undefined {
  return items.find(
    (it) => typeof it.label === 'string' && it.label.startsWith(prefix)
  );
}

function statuses(): Record<string, ServerStatus> {
  return {
    idle: { state: 'idle', port: 5002 },
    starting: { state: 'starting', port: 5002 },
    running: { state: 'running', port: 5050, pid: 1234 },
    stopping: { state: 'stopping', port: 5002 },
    crashed: {
      state: 'crashed',
      port: 5002,
      errorMessage: 'sidecar crashed 5 times',
    },
    port_in_use: {
      state: 'port_in_use',
      port: 5002,
      errorMessage: 'Port 5002 is already in use.',
    },
    error: {
      state: 'error',
      port: 5002,
      errorMessage: 'health_probe_timeout',
    },
  };
}

describe('trayTooltip', () => {
  const all = statuses();
  it('mentions the running port', () => {
    expect(trayTooltip(all.running)).toContain('5050');
    expect(trayTooltip(all.running).toLowerCase()).toContain('running');
  });
  it('describes port_in_use with the port number', () => {
    expect(trayTooltip(all.port_in_use)).toMatch(/in use/i);
    expect(trayTooltip(all.port_in_use)).toContain('5002');
  });
  it('shows error message when present', () => {
    expect(trayTooltip(all.error)).toMatch(/error/i);
    expect(trayTooltip(all.error)).toContain('health_probe_timeout');
  });
  it('describes idle as server stopped', () => {
    expect(trayTooltip(all.idle)).toMatch(/stopped/i);
  });
});

describe('buildTrayTemplate', () => {
  it('running state: stop + restart enabled, start disabled, header shows port', () => {
    const items = buildTrayTemplate(
      statuses().running,
      makeHandlers(),
      '0.1.0'
    ) as Item[];
    const header = items[0];
    expect(header.enabled).toBe(false);
    expect(header.label).toMatch(/running on :5050/);
    expect(findByLabelStart(items, 'Start Server')?.enabled).toBe(false);
    expect(findByLabelStart(items, 'Stop Server')?.enabled).toBe(true);
    expect(findByLabelStart(items, 'Restart Server')?.enabled).toBe(true);
    expect(findByLabelStart(items, 'Retry Start')).toBeUndefined();
    // Open / Settings / Logs always present.
    expect(findByLabelStart(items, 'Open freekoko')).toBeDefined();
    expect(findByLabelStart(items, 'Settings')).toBeDefined();
    expect(findByLabelStart(items, 'Logs')).toBeDefined();
    expect(findByLabelStart(items, 'About freekoko')?.label).toContain(
      '0.1.0'
    );
    expect(findByLabelStart(items, 'Quit freekoko')?.enabled).not.toBe(false);
  });

  it('idle state: start enabled, stop + restart disabled, header says stopped', () => {
    const items = buildTrayTemplate(
      statuses().idle,
      makeHandlers(),
      ''
    ) as Item[];
    expect(items[0].enabled).toBe(false);
    expect(items[0].label).toMatch(/stopped/i);
    expect(findByLabelStart(items, 'Start Server')?.enabled).toBe(true);
    expect(findByLabelStart(items, 'Stop Server')?.enabled).toBe(false);
    expect(findByLabelStart(items, 'Restart Server')?.enabled).toBe(false);
  });

  it('starting state: stop enabled, start + restart disabled', () => {
    const items = buildTrayTemplate(
      statuses().starting,
      makeHandlers(),
      ''
    ) as Item[];
    expect(items[0].label).toMatch(/Starting/);
    expect(findByLabelStart(items, 'Start Server')?.enabled).toBe(false);
    expect(findByLabelStart(items, 'Stop Server')?.enabled).toBe(true);
    expect(findByLabelStart(items, 'Restart Server')?.enabled).toBe(false);
  });

  it('stopping state: everything disabled except app/open/settings/logs/quit', () => {
    const items = buildTrayTemplate(
      statuses().stopping,
      makeHandlers(),
      ''
    ) as Item[];
    expect(items[0].label).toMatch(/Stopping/);
    expect(findByLabelStart(items, 'Start Server')?.enabled).toBe(false);
    expect(findByLabelStart(items, 'Stop Server')?.enabled).toBe(false);
    expect(findByLabelStart(items, 'Restart Server')?.enabled).toBe(false);
  });

  it('port_in_use state: header mentions open Settings, Retry Start is offered', () => {
    const items = buildTrayTemplate(
      statuses().port_in_use,
      makeHandlers(),
      ''
    ) as Item[];
    expect(items[0].label).toContain('Port 5002 in use');
    expect(items[0].label).toMatch(/Settings/);
    expect(findByLabelStart(items, 'Retry Start')?.enabled).toBe(true);
    // The Start / Stop / Restart triad collapses to just Retry in the error shapes.
    expect(findByLabelStart(items, 'Start Server')).toBeUndefined();
    expect(findByLabelStart(items, 'Stop Server')).toBeUndefined();
  });

  it('crashed state: Retry Start enabled, header shows error message', () => {
    const items = buildTrayTemplate(
      statuses().crashed,
      makeHandlers(),
      ''
    ) as Item[];
    expect(items[0].label).toContain('sidecar crashed 5 times');
    expect(findByLabelStart(items, 'Retry Start')?.enabled).toBe(true);
  });

  it('error state: Retry Start enabled, header shows error message', () => {
    const items = buildTrayTemplate(
      statuses().error,
      makeHandlers(),
      ''
    ) as Item[];
    expect(items[0].label).toContain('health_probe_timeout');
    expect(findByLabelStart(items, 'Retry Start')?.enabled).toBe(true);
  });

  it('Retry Start invokes handlers.onRetry (not onStart) in crashed state', () => {
    const handlers = makeHandlers();
    const items = buildTrayTemplate(
      statuses().crashed,
      handlers,
      ''
    ) as (Item & { click?: () => void })[];
    const retry = items.find((i) => i.label === 'Retry Start');
    retry?.click?.();
    expect(handlers.onRetry).toHaveBeenCalledTimes(1);
    expect(handlers.onStart).not.toHaveBeenCalled();
  });

  it('About handler is wired on the About menu item', () => {
    const handlers = makeHandlers();
    const items = buildTrayTemplate(
      statuses().idle,
      handlers,
      '1.2.3'
    ) as (Item & { click?: () => void })[];
    const about = items.find(
      (i) => typeof i.label === 'string' && i.label.startsWith('About freekoko')
    );
    expect(about?.label).toContain('1.2.3');
    about?.click?.();
    expect(handlers.onShowAbout).toHaveBeenCalledTimes(1);
  });

  it('Quit menu item wires onQuit and has Cmd+Q accelerator', () => {
    const handlers = makeHandlers();
    const items = buildTrayTemplate(
      statuses().idle,
      handlers,
      ''
    ) as (Item & { click?: () => void; accelerator?: string })[];
    const quit = items.find((i) => i.label === 'Quit freekoko');
    expect(quit?.accelerator).toBe('Command+Q');
    quit?.click?.();
    expect(handlers.onQuit).toHaveBeenCalledTimes(1);
  });
});
