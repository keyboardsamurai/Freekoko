import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { SettingsView } from './SettingsView';
import type { AppSettings, VoiceInfo } from '@shared/types';

// --- electronAPI stub ---------------------------------------------------

type Api = Window['electronAPI'];

function makeApi(overrides: Partial<AppSettings> = {}): Api {
  let current: AppSettings = {
    port: 5002,
    outputDir: '/tmp/freekoko/history',
    defaultVoice: 'af_heart',
    defaultSpeed: 1.0,
    launchOnLogin: false,
    autoStartServer: true,
    ...overrides,
  };
  const listeners: Array<(s: AppSettings) => void> = [];
  const voices: VoiceInfo[] = [
    {
      id: 'af_heart',
      name: 'Heart',
      language: 'en-US',
      languageName: 'American English',
      gender: 'Female',
      quality: 'A',
    },
    {
      id: 'bf_alice',
      name: 'Alice',
      language: 'en-GB',
      languageName: 'British English',
      gender: 'Female',
      quality: 'A',
    },
  ];
  return {
    supervisor: {
      start: vi.fn().mockResolvedValue({ state: 'running', port: current.port }),
      stop: vi.fn().mockResolvedValue({ state: 'idle', port: current.port }),
      restart: vi
        .fn()
        .mockResolvedValue({ state: 'running', port: current.port }),
      status: vi
        .fn()
        .mockResolvedValue({ state: 'running', port: current.port }),
    },
    tts: {
      generate: vi.fn(),
      voices: vi.fn().mockResolvedValue(voices),
      health: vi.fn(),
    },
    history: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      delete: vi.fn(),
      saveWav: vi.fn(),
      readWav: vi.fn(),
      clear: vi.fn(),
    },
    settings: {
      get: vi
        .fn()
        .mockImplementation((key: keyof AppSettings) => current[key]) as Api['settings']['get'],
      set: vi.fn().mockImplementation(async (patch: Partial<AppSettings>) => {
        current = { ...current, ...patch };
        listeners.forEach((cb) => cb(current));
        return current;
      }) as Api['settings']['set'],
      getAll: vi.fn().mockImplementation(async () => current) as Api['settings']['getAll'],
      chooseDirectory: vi
        .fn()
        .mockResolvedValue({ ok: true, path: '/Users/me/Desktop/kokoro' }),
      openPath: vi.fn().mockResolvedValue({ ok: true }),
    },
    logs: {
      recent: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue({ ok: true as const }),
    },
    window: {
      showMain: vi.fn().mockResolvedValue({ ok: true as const }),
    },
    app: {
      getVersion: vi.fn().mockResolvedValue('0.1.0'),
      openUrl: vi.fn().mockResolvedValue({ ok: true }),
    },
    onServerStatus: () => () => undefined,
    onLogLine: () => () => undefined,
    onSettingsChanged: (cb) => {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    onTtsProgress: () => () => undefined,
    onNavigate: () => () => undefined,
  } satisfies Api;
}

describe('SettingsView', () => {
  beforeEach(() => {
    window.electronAPI = makeApi();
  });

  afterEach(() => {
    cleanup();
    // @ts-expect-error — test cleanup
    delete window.electronAPI;
  });

  it('renders all four sections + About', async () => {
    render(<SettingsView />);
    // Wait for hydrate
    await waitFor(() =>
      expect(screen.getByLabelText(/HTTP port/i)).toBeInTheDocument()
    );
    expect(
      screen.getByRole('heading', { level: 3, name: /Server/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: /Generation defaults/i,
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: /Storage/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: /System/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: /About/i })
    ).toBeInTheDocument();
  });

  it('hydrates the port input with current settings', async () => {
    render(<SettingsView />);
    await waitFor(() =>
      expect(screen.getByLabelText(/HTTP port/i)).toHaveValue(5002)
    );
  });

  it('save-on-blur persists a valid port change via IPC', async () => {
    render(<SettingsView />);
    const input = await screen.findByLabelText(/HTTP port/i);
    fireEvent.change(input, { target: { value: '5099' } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(window.electronAPI.settings.set).toHaveBeenCalledWith({
        port: 5099,
      })
    );
  });

  it('rejects out-of-range port values with an inline error', async () => {
    render(<SettingsView />);
    const input = await screen.findByLabelText(/HTTP port/i);
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.blur(input);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /between 1024 and 65535/i
    );
    expect(window.electronAPI.settings.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ port: 42 })
    );
  });

  it('shows the restart warning when the draft port differs from the running port', async () => {
    render(<SettingsView />);
    const input = await screen.findByLabelText(/HTTP port/i);
    fireEvent.change(input, { target: { value: '5050' } });
    // Draft differs from running (5002 from hydrate), warning should appear.
    expect(
      await screen.findByText(/Port change takes effect on next server restart/i)
    ).toBeInTheDocument();
    const restart = screen.getByRole('button', { name: /Restart Server Now/i });
    fireEvent.click(restart);
    await waitFor(() =>
      expect(window.electronAPI.supervisor.restart).toHaveBeenCalled()
    );
  });

  it('checkbox toggles persist immediately (save-on-change)', async () => {
    render(<SettingsView />);
    const launchAtLogin = await screen.findByLabelText(/Launch freekoko at login/i);
    fireEvent.click(launchAtLogin);
    await waitFor(() =>
      expect(window.electronAPI.settings.set).toHaveBeenCalledWith({
        launchOnLogin: true,
      })
    );

    const autoStart = screen.getByLabelText(
      /Automatically start the server when freekoko launches/i
    );
    fireEvent.click(autoStart);
    await waitFor(() =>
      expect(window.electronAPI.settings.set).toHaveBeenCalledWith({
        autoStartServer: false,
      })
    );
  });

  it('voice select change is saved immediately', async () => {
    render(<SettingsView />);
    const select = await screen.findByLabelText(/Default voice/i);
    await waitFor(() =>
      // voice list hydrates after the initial render
      expect(select.querySelector('option[value="bf_alice"]')).not.toBeNull()
    );
    fireEvent.change(select, { target: { value: 'bf_alice' } });
    await waitFor(() =>
      expect(window.electronAPI.settings.set).toHaveBeenCalledWith({
        defaultVoice: 'bf_alice',
      })
    );
  });

  it('speed input change is saved immediately', async () => {
    render(<SettingsView />);
    const speed = await screen.findByLabelText(/Default speed/i);
    fireEvent.change(speed, { target: { value: '1.4' } });
    await waitFor(() =>
      expect(window.electronAPI.settings.set).toHaveBeenCalledWith({
        defaultSpeed: 1.4,
      })
    );
  });

  it('Change… button invokes chooseDirectory and persists the result', async () => {
    render(<SettingsView />);
    const change = await screen.findByRole('button', { name: /Change…/i });
    fireEvent.click(change);
    await waitFor(() =>
      expect(window.electronAPI.settings.chooseDirectory).toHaveBeenCalled()
    );
    await waitFor(() =>
      expect(window.electronAPI.settings.set).toHaveBeenCalledWith({
        outputDir: '/Users/me/Desktop/kokoro',
      })
    );
  });

  it('Open Folder button calls openPath with the current output dir', async () => {
    render(<SettingsView />);
    const open = await screen.findByRole('button', { name: /Open Folder/i });
    fireEvent.click(open);
    await waitFor(() =>
      expect(window.electronAPI.settings.openPath).toHaveBeenCalledWith(
        '/tmp/freekoko/history'
      )
    );
  });
});
