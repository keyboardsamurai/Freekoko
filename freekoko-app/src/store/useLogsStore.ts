import { create } from 'zustand';
import type { LogEntry } from '../lib/types';

const MAX_LINES = 2000;

interface LogsState {
  lines: LogEntry[];
  append: (entry: LogEntry) => void;
  replace: (entries: LogEntry[]) => void;
  clear: () => void;
}

export const useLogsStore = create<LogsState>((set) => ({
  lines: [],
  append: (entry) =>
    set((s) => {
      const next = s.lines.length >= MAX_LINES ? s.lines.slice(1) : s.lines.slice();
      next.push(entry);
      return { lines: next };
    }),
  replace: (entries) => set({ lines: entries.slice(-MAX_LINES) }),
  clear: () => set({ lines: [] }),
}));
