// @vitest-environment happy-dom
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import { HistoryItem } from './HistoryItem';
import type { HistoryItem as HistoryItemType } from '../lib/types';

type ApiMock = {
  history: {
    list: ReturnType<typeof vi.fn>;
    readWav: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    saveWav: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
};

function installApi(overrides: Partial<ApiMock['history']> = {}): ApiMock {
  const api: ApiMock = {
    history: {
      list: vi.fn().mockResolvedValue([]),
      readWav: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      get: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      delete: vi.fn().mockResolvedValue({ ok: true }),
      saveWav: vi.fn().mockResolvedValue({ ok: true, savedPath: '/tmp/out.wav' }),
      clear: vi.fn().mockResolvedValue({ ok: true }),
      ...overrides,
    },
  };
  // Happy-dom exposes `window` on globalThis; tolerate either path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.window) g.window.electronAPI = api;
  g.electronAPI = api;
  return api;
}

const fixedNow = new Date('2026-04-14T12:00:00Z');

const longText =
  'Hello, world. This is a test of the freekoko TTS system and it should be truncated because it is way longer than one hundred and twenty characters in length.';

const baseItem: HistoryItemType = {
  id: 'abc-123',
  createdAt: '2026-04-14T11:57:00Z',
  voice: 'af_heart',
  speed: 1.0,
  text: longText,
  previewText: longText.slice(0, 120),
  wavFilename: 'abc-123.wav',
  durationMs: 5000,
  sampleCount: 120000,
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(globalThis as any).URL.createObjectURL) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:mock');
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(globalThis as any).URL.revokeObjectURL) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).URL.revokeObjectURL = vi.fn();
  }
});

describe('HistoryItem', () => {
  it('renders relative timestamp, voice badge, and truncated preview', () => {
    installApi();
    // Force a preview longer than 120 chars so the truncate helper adds
    // an ellipsis — independent of what previewText the server supplied.
    const item: HistoryItemType = {
      ...baseItem,
      previewText: 'x'.repeat(300),
    };
    const { getByText, container } = render(
      <HistoryItem item={item} now={fixedNow} />
    );
    expect(getByText('3 minutes ago')).toBeTruthy();
    const badge = container.querySelector('.history-item-voice-badge');
    expect(badge?.textContent).toContain('Heart');
    expect(badge?.textContent).toContain('(F, A)');
    const preview = container.querySelector('.history-item-preview')?.textContent ?? '';
    expect(preview.length).toBeLessThanOrEqual(125); // includes quotes
    expect(preview.includes('…')).toBe(true);
  });

  it('invokes onDeleted when Delete is confirmed', async () => {
    const api = installApi();
    const onDeleted = vi.fn();
    const { getByTestId } = render(
      <HistoryItem
        item={baseItem}
        now={fixedNow}
        onDeleted={onDeleted}
        confirmFn={() => true}
      />
    );
    fireEvent.click(getByTestId('history-item-delete'));
    await waitFor(() => {
      expect(api.history.delete).toHaveBeenCalledWith({ id: 'abc-123' });
      expect(onDeleted).toHaveBeenCalledWith('abc-123');
    });
  });

  it('does not delete when confirmation is declined', async () => {
    const api = installApi();
    const onDeleted = vi.fn();
    const { getByTestId } = render(
      <HistoryItem
        item={baseItem}
        now={fixedNow}
        onDeleted={onDeleted}
        confirmFn={() => false}
      />
    );
    fireEvent.click(getByTestId('history-item-delete'));
    // Allow any microtasks to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(api.history.delete).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('loads audio lazily on Play click', async () => {
    const api = installApi();
    const { getByTestId, queryByTestId } = render(
      <HistoryItem item={baseItem} now={fixedNow} />
    );
    expect(queryByTestId('history-item-audio')).toBeNull();
    fireEvent.click(getByTestId('history-item-play'));
    await waitFor(() => {
      expect(api.history.readWav).toHaveBeenCalledWith({ id: 'abc-123' });
      expect(queryByTestId('history-item-audio')).not.toBeNull();
    });
  });
});
