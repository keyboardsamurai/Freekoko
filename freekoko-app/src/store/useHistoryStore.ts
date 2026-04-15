import { create } from 'zustand';
import type { HistoryItem } from '../lib/types';
import {
  clearHistory as ipcClearHistory,
  deleteHistory as ipcDeleteHistory,
  listHistory as ipcListHistory,
} from '../lib/ipc';

interface HistoryState {
  items: HistoryItem[];
  isLoading: boolean;
  /** Text/voice staged by "Re-use Text" for the Generate view. */
  pendingPrefill: { text: string; voice: string } | null;

  // Actions
  setItems: (items: HistoryItem[]) => void;
  loadHistory: () => Promise<HistoryItem[]>;
  add: (item: HistoryItem) => void;
  remove: (id: string) => Promise<boolean>;
  clear: () => Promise<boolean>;
  reuseItem: (id: string) => { text: string; voice: string } | null;
  consumePrefill: () => { text: string; voice: string } | null;
  replayLast: () => HistoryItem | null;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  items: [],
  isLoading: false,
  pendingPrefill: null,

  setItems: (items) => set({ items }),

  async loadHistory() {
    set({ isLoading: true });
    try {
      const items = await ipcListHistory({ limit: 500 });
      set({ items });
      return items;
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

  reuseItem(id) {
    const item = get().items.find((x) => x.id === id);
    if (!item) return null;
    const prefill = { text: item.text, voice: item.voice };
    set({ pendingPrefill: prefill });
    return prefill;
  },

  consumePrefill() {
    const p = get().pendingPrefill;
    if (p) set({ pendingPrefill: null });
    return p;
  },

  replayLast() {
    return get().items[0] ?? null;
  },
}));
