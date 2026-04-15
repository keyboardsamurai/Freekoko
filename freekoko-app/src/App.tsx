import { useEffect } from 'react';
import { StatusBadge } from './components/StatusBadge';
import { GenerateView } from './views/GenerateView';
import { HistoryView } from './views/HistoryView';
import { LogsView } from './views/LogsView';
import { SettingsView } from './views/SettingsView';
import { onNavigate, onTtsDone } from './lib/ipc';
import { useAppStore, type Tab } from './store/useAppStore';
import { useHistoryStore } from './store/useHistoryStore';

const TABS: { id: Tab; label: string }[] = [
  { id: 'generate', label: 'Generate' },
  { id: 'history', label: 'History' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  const currentTab = useAppStore((s) => s.currentTab);
  const setTab = useAppStore((s) => s.setTab);
  const addHistoryItem = useHistoryStore((s) => s.add);

  // Tray + app-menu items broadcast `on:navigate` to the renderer; P5
  // exposes `onNavigate` via preload so deep-links flip tabs and the
  // target view can scroll to a named section.
  useEffect(() => {
    const off = onNavigate((payload) => {
      if (payload?.tab) setTab(payload.tab as Tab);
    });
    return () => off();
  }, [setTab]);

  // App-level tts:done listener. Lives above the tab lifecycle so a
  // streaming generation that completes while the user is on any other
  // tab still populates the history store. GenerateView has its own
  // `onTtsDone` subscription for UI state (swap Stop→Generate, drive the
  // streaming→static handoff), but the authoritative store write happens
  // here — the renderer store is the single source of truth for History
  // and must not depend on which view is mounted. `add()` dedupes by id.
  useEffect(() => {
    const off = onTtsDone((evt) => {
      addHistoryItem(evt.item);
    });
    return () => off();
  }, [addHistoryItem]);

  return (
    <div className="app-shell">
      <header className="app-header" data-drag="true">
        <div className="app-title">freekoko</div>
        <nav className="tab-bar">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`tab${currentTab === t.id ? ' tab-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <StatusBadge />
      </header>
      <main className="app-main">
        {currentTab === 'generate' && <GenerateView />}
        {currentTab === 'history' && <HistoryView />}
        {currentTab === 'logs' && <LogsView />}
        {currentTab === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
