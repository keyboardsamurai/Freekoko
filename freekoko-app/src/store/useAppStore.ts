import { create } from 'zustand';
import type { ServerStatus } from '../lib/types';

export type Tab = 'generate' | 'history' | 'logs' | 'settings';

export interface PendingGenerate {
  text: string;
  voice?: string;
  /** Bumps every time a new re-use request arrives so consumers can
   * effect-react even if text/voice happen to be identical. */
  nonce: number;
}

interface AppState {
  currentTab: Tab;
  setTab: (tab: Tab) => void;
  status: ServerStatus;
  setStatus: (status: ServerStatus) => void;
  /** Populated by HistoryView's "Re-use Text" action; consumed (and
   * cleared) by GenerateView on mount / when nonce changes. */
  pendingGenerate: PendingGenerate | null;
  reuseInGenerate: (args: { text: string; voice?: string }) => void;
  consumePendingGenerate: () => PendingGenerate | null;
}

export const useAppStore = create<AppState>((set, get) => ({
  currentTab: 'generate',
  setTab: (tab) => set({ currentTab: tab }),
  status: { state: 'idle', port: 5002 },
  setStatus: (status) => set({ status }),
  pendingGenerate: null,
  reuseInGenerate: ({ text, voice }) => {
    const prev = get().pendingGenerate;
    set({
      pendingGenerate: {
        text,
        voice,
        nonce: (prev?.nonce ?? 0) + 1,
      },
      currentTab: 'generate',
    });
  },
  consumePendingGenerate: () => {
    const pg = get().pendingGenerate;
    if (pg) set({ pendingGenerate: null });
    return pg;
  },
}));
