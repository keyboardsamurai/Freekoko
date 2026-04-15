import { create } from 'zustand';
import type { HistoryItem } from '../lib/types';
import {
  clearHistory as ipcClearHistory,
  deleteHistory as ipcDeleteHistory,
  isIpcError,
  listHistory as ipcListHistory,
} from '../lib/ipc';

interface HistoryState {
  items: HistoryItem[];
  isLoading: boolean;
  /** Latest IPC error from `loadHistory()`; `null` while healthy. */
  error: string | null;

  // Actions
  setItems: (items: HistoryItem[]) => void;
  loadHistory: () => Promise<HistoryItem[]>;
  add: (item: HistoryItem) => void;
  remove: (id: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
  replayLast: () => HistoryItem | null;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  items: [],
  isLoading: false,
  error: null,

  setItems: (items) => set({ items }),

  async loadHistory() {
    set({ isLoading: true, error: null });
    try {
      const res = await ipcListHistory({ limit: 500 });
      if (isIpcError(res)) {
        // Failure is visible — keep prior items intact so the UI doesn't
        // blink to empty during a transient outage.
        set({ error: res.message ?? res.error });
        return get().items;
      }
      set({ items: res });
      return res;
    } finally {
      set({ isLoading: false });
    }
  },

  add(item) {
    set((s) => ({ items: [item, ...s.items.filter((x) => x.id !== item.id)] }));
  },

  async remove(id) {
    const ok = await ipcDeleteHistory(id);
    if (ok) {
      set((s) => ({ items: s.items.filter((x) => x.id !== id) }));
    }
    return ok;
  },

  async clear() {
    const res = await ipcClearHistory(true);
    if (res.ok) set({ items: [] });
    return res.ok;
  },

  replayLast() {
    return get().items[0] ?? null;
  },
}));
