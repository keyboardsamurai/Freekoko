// @vitest-environment happy-dom
//
// Integration test: codifies the invariant from root CLAUDE.md that the
// `onTtsDone` → `useHistoryStore.getState().add()` subscription lives in
// `src/App.tsx` (NOT `GenerateView.tsx`). If the subscription ever moves
// back into the view, switching tabs mid-stream will drop history entries
// and this test will go red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, fireEvent, waitFor } from '@testing-library/react';

import { App } from './App';
import { useHistoryStore } from './store/useHistoryStore';
import { useAppStore } from './store/useAppStore';
import type {
  AppSettings,
  HistoryItem,
  TtsChunkEvent,
  TtsDoneEvent,
  TtsErrorEvent,
  VoiceInfo,
} from './lib/types';

// ---------------------------------------------------------------------------
// electronAPI stub — mirrors the shape preload exposes, with explicit
// per-channel event broadcasters that tests fire to simulate the main
// process.
// ---------------------------------------------------------------------------

interface EventChannels {
  ttsChunkSubs: Array<(e: TtsChunkEvent) => void>;
  ttsDoneSubs: Array<(e: TtsDoneEvent) => void>;
  ttsErrorSubs: Array<(e: TtsErrorEvent) => void>;
}

function makeApi(channels: EventChannels): Window['electronAPI'] {
  const settings: AppSettings = {
    port: 5002,
    outputDir: '/tmp/out',
    defaultVoice: 'af_heart',
    defaultSpeed: 1.0,
    launchOnLogin: false,
    autoStartServer: true,
  };
  const voices: VoiceInfo[] = [
    {
      id: 'af_heart',
      name: 'Heart',
      language: 'en-US',
      languageName: 'American English',
      gender: 'Female',
      quality: 'A',
    },
  ];
  return {
    supervisor: {
      // Not running — the Generate button is disabled, but that's fine:
      // we drive the state machine via direct generateTTSStream mocks below.
      start: vi.fn().mockResolvedValue({ state: 'running', port: 5002 }),
      stop: vi.fn().mockResolvedValue({ state: 'idle', port: 5002 }),
      restart: vi.fn().mockResolvedValue({ state: 'running', port: 5002 }),
      status: vi.fn().mockResolvedValue({ state: 'running', port: 5002 }),
    },
    tts: {
      generate: vi.fn(),
      generateStream: vi
        .fn()
        .mockResolvedValue({ requestId: 'req-test-1' }),
      abort: vi.fn().mockResolvedValue({ ok: true }),
      voices: vi.fn().mockResolvedValue(voices),
    },
    history: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue({ ok: true, removed: true }),
      saveWav: vi.fn().mockResolvedValue({ ok: true }),
      readWav: vi
        .fn()
        .mockResolvedValue({ ok: true, bytes: new Uint8Array([1, 2, 3]) }),
      clear: vi.fn().mockResolvedValue({ ok: true }),
    },
    settings: {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue(settings),
      getAll: vi.fn().mockResolvedValue(settings),
      chooseDirectory: vi.fn(),
      openPath: vi.fn(),
    },
    logs: {
      recent: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue({ ok: true }),
    },
    window: { showMain: vi.fn().mockResolvedValue({ ok: true }) },
    app: {
      getVersion: vi.fn().mockResolvedValue('0.1.0'),
      openUrl: vi.fn().mockResolvedValue({ ok: true }),
    },
    onServerStatus: () => () => undefined,
    onLogLine: () => () => undefined,
    onSettingsChanged: () => () => undefined,
    onTtsProgress: () => () => undefined,
    onTtsChunk: (cb) => {
      channels.ttsChunkSubs.push(cb);
      return () => {
        const i = channels.ttsChunkSubs.indexOf(cb);
        if (i >= 0) channels.ttsChunkSubs.splice(i, 1);
      };
    },
    onTtsDone: (cb) => {
      channels.ttsDoneSubs.push(cb);
      return () => {
        const i = channels.ttsDoneSubs.indexOf(cb);
        if (i >= 0) channels.ttsDoneSubs.splice(i, 1);
      };
    },
    onTtsError: (cb) => {
      channels.ttsErrorSubs.push(cb);
      return () => {
        const i = channels.ttsErrorSubs.indexOf(cb);
        if (i >= 0) channels.ttsErrorSubs.splice(i, 1);
      };
    },
    onNavigate: () => () => undefined,
  };
}

function resetStores() {
  // Zustand stores persist between tests because they live at module
  // scope. Reset to the known-empty initial shape.
  useHistoryStore.setState({
    items: [],
    isLoading: false,
    error: null,
  });
  useAppStore.setState({
    currentTab: 'generate',
    status: { state: 'running', port: 5002 },
    pendingGenerate: null,
  });
}

// ---------------------------------------------------------------------------

describe('App-level onTtsDone subscription survives GenerateView unmount', () => {
  let channels: EventChannels;

  beforeEach(() => {
    channels = { ttsChunkSubs: [], ttsDoneSubs: [], ttsErrorSubs: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).electronAPI = makeApi(channels);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI = (globalThis as any).electronAPI;
    resetStores();
  });

  afterEach(() => {
    cleanup();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).electronAPI;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electronAPI;
    resetStores();
  });

  it('history entry is persisted even when tts:done fires after GenerateView unmounts', async () => {
    const { getByRole } = render(<App />);

    // Wait until the GenerateView heading is on screen.
    await waitFor(() =>
      expect(getByRole('heading', { name: /Generate/i })).toBeTruthy()
    );

    // Sanity: history store is empty.
    expect(useHistoryStore.getState().items).toEqual([]);

    // App.tsx sets up the onTtsDone listener on mount; sanity-check the
    // subscription was registered.
    expect(channels.ttsDoneSubs.length).toBeGreaterThanOrEqual(1);
    const initialDoneSubCount = channels.ttsDoneSubs.length;

    // Switch tabs to unmount GenerateView. The History tab will trigger a
    // listHistory (returns [] from the stub).
    const historyTab = getByRole('button', { name: 'History' });
    act(() => {
      fireEvent.click(historyTab);
    });
    await waitFor(() =>
      expect(getByRole('heading', { name: /History/i })).toBeTruthy()
    );

    // Critical: the App-level done subscription must STILL be present —
    // GenerateView unmounting should not have removed it. (The view has
    // its own done listener for UI state, which DID unmount with it; we
    // assert the App-level one survived by sub-count remaining ≥ 1.)
    expect(channels.ttsDoneSubs.length).toBeGreaterThanOrEqual(1);
    // It should be the same listener (never re-installed). The simplest
    // way to assert that is that count didn't *grow*, just shrink by the
    // GenerateView-owned one (or stayed the same if the view had been
    // late-mounting its listener).
    expect(channels.ttsDoneSubs.length).toBeLessThanOrEqual(initialDoneSubCount);

    // Now fire the final tts:done event — simulating the streaming
    // generation finishing AFTER the user navigated away.
    const persistedItem: HistoryItem = {
      id: 'item-persist-test',
      createdAt: '2026-04-15T00:00:00Z',
      text: 'Hello from a stream that finished after unmount.',
      voice: 'af_heart',
      speed: 1.0,
      sampleCount: 24000,
      durationMs: 1000,
      wavFilename: 'item-persist-test.wav',
      previewText: 'Hello from a stream that finished after unmount.',
    };
    act(() => {
      const evt: TtsDoneEvent = {
        requestId: 'req-test-1',
        item: persistedItem,
        wavPath: '/tmp/out/item-persist-test.wav',
        partial: false,
      };
      for (const sub of channels.ttsDoneSubs) sub(evt);
    });

    // Assertion: the App-level subscription called add(), and the entry
    // is in the store. This is the entire invariant under test.
    await waitFor(() => {
      const items = useHistoryStore.getState().items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(persistedItem.id);
    });
  });
});
