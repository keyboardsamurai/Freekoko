import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
} from 'react';
import type { AppSettings, VoiceInfo } from '@shared/types';

import { About } from '../components/About';
import {
  chooseDirectory,
  getAllSettings,
  listVoices,
  onNavigate,
  onSettingsChanged,
  openPath,
  restartServer,
  setSettings,
} from '../lib/ipc';

const PORT_MIN = 1024;
const PORT_MAX = 65535;
const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;
const SPEED_STEP = 0.1;

// Fallback voice list used when the sidecar isn't running and tts.voices
// returns nothing. Keeps the select populated with at least the default.
const FALLBACK_VOICES: VoiceInfo[] = [
  {
    id: 'af_heart',
    name: 'Heart',
    language: 'en-US',
    languageName: 'American English',
    gender: 'Female',
    quality: 'A',
  },
];

type BusyKey = 'outputDir' | 'restart';

export function SettingsView() {
  const [settings, setSettingsState] = useState<AppSettings | null>(null);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  // Local string mirror for the port input so we can validate on blur
  // without fighting React's controlled inputs.
  const [portDraft, setPortDraft] = useState<string>('');
  const [portError, setPortError] = useState<string | null>(null);
  // Track the running port so the warning banner knows when to appear.
  const [runningPort, setRunningPort] = useState<number | null>(null);
  const [busy, setBusy] = useState<Record<BusyKey, boolean>>({
    outputDir: false,
    restart: false,
  });

  const aboutRef = useRef<HTMLElement | null>(null);

  // Initial hydrate + subscribe to external changes.
  useEffect(() => {
    let alive = true;

    getAllSettings()
      .then((s) => {
        if (!alive) return;
        setSettingsState(s);
        setPortDraft(String(s.port));
        setRunningPort((prev) => prev ?? s.port);
      })
      .catch(() => {
        /* best-effort */
      });

    const off = onSettingsChanged((s) => {
      if (!alive) return;
      setSettingsState(s);
      setPortDraft((draft) => {
        // Only reset the draft if the user isn't mid-edit on port.
        const parsed = parseInt(draft, 10);
        if (Number.isFinite(parsed) && parsed === s.port) {
          return String(s.port);
        }
        return draft;
      });
    });

    return () => {
      alive = false;
      off();
    };
  }, []);

  // Best-effort voice list — only populates when the sidecar is running.
  useEffect(() => {
    let alive = true;
    listVoices()
      .then((list) => {
        if (alive && list.length) setVoices(list);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Tray/app-menu deep-link → scroll About into view.
  useEffect(() => {
    const off = onNavigate((payload) => {
      if (payload?.tab === 'settings' && payload.section === 'about') {
        // Defer so the view's containing scroll element has the current DOM.
        requestAnimationFrame(() => {
          aboutRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    });
    return () => off();
  }, []);

  const patch = useCallback(async (partial: Partial<AppSettings>) => {
    try {
      const next = await setSettings(partial);
      setSettingsState(next);
    } catch {
      /* surfacing would require a toast — silently ignore for now */
    }
  }, []);

  const onPortBlur = useCallback(
    async (evt: FocusEvent<HTMLInputElement>) => {
      const draft = evt.target.value.trim();
      const parsed = parseInt(draft, 10);
      if (!Number.isFinite(parsed) || parsed < PORT_MIN || parsed > PORT_MAX) {
        setPortError(`Port must be between ${PORT_MIN} and ${PORT_MAX}.`);
        return;
      }
      setPortError(null);
      if (settings && parsed !== settings.port) {
        await patch({ port: parsed });
      }
    },
    [patch, settings]
  );

  const handleChooseDirectory = useCallback(async () => {
    if (!settings) return;
    setBusy((b) => ({ ...b, outputDir: true }));
    try {
      const res = await chooseDirectory(settings.outputDir);
      if (res.ok) {
        await patch({ outputDir: res.path });
      }
    } finally {
      setBusy((b) => ({ ...b, outputDir: false }));
    }
  }, [patch, settings]);

  const handleOpenFolder = useCallback(async () => {
    if (!settings?.outputDir) return;
    await openPath(settings.outputDir);
  }, [settings]);

  const handleRestartServer = useCallback(async () => {
    setBusy((b) => ({ ...b, restart: true }));
    try {
      const res = await restartServer();
      setRunningPort(res.port);
    } finally {
      setBusy((b) => ({ ...b, restart: false }));
    }
  }, []);

  const onAutoStartChange = (evt: ChangeEvent<HTMLInputElement>) => {
    void patch({ autoStartServer: evt.target.checked });
  };
  const onLaunchLoginChange = (evt: ChangeEvent<HTMLInputElement>) => {
    void patch({ launchOnLogin: evt.target.checked });
  };
  const onVoiceChange = (evt: ChangeEvent<HTMLSelectElement>) => {
    void patch({ defaultVoice: evt.target.value });
  };
  const onSpeedChange = (evt: ChangeEvent<HTMLInputElement>) => {
    const n = Number.parseFloat(evt.target.value);
    if (Number.isFinite(n)) void patch({ defaultSpeed: n });
  };

  if (!settings) {
    return (
      <section className="view settings-view">
        <h2>Settings</h2>
        <p className="muted">Loading settings…</p>
      </section>
    );
  }

  const parsedPort = parseInt(portDraft, 10);
  const validPort =
    Number.isFinite(parsedPort) &&
    parsedPort >= PORT_MIN &&
    parsedPort <= PORT_MAX;
  const portChangedVsRunning =
    validPort && runningPort != null && parsedPort !== runningPort;

  const voiceOptions = voices.length ? voices : FALLBACK_VOICES;
  const knownVoice = voiceOptions.some((v) => v.id === settings.defaultVoice);
  const groupedVoices = groupVoicesByLanguage(voiceOptions);

  return (
    <section className="view settings-view">
      <h2>Settings</h2>

      {/* Server ---------------------------------------------------------- */}
      <section className="settings-section" aria-labelledby="sec-server">
        <h3 id="sec-server" className="settings-heading">
          Server
        </h3>
        <div className="settings-card">
          <div className="settings-row">
            <label className="settings-label" htmlFor="port-input">
              HTTP port
            </label>
            <div className="settings-control">
              <input
                id="port-input"
                type="number"
                inputMode="numeric"
                min={PORT_MIN}
                max={PORT_MAX}
                step={1}
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onBlur={onPortBlur}
                aria-invalid={!!portError}
                aria-describedby={portError ? 'port-error' : undefined}
                className={portError ? 'invalid' : ''}
              />
              <span className="settings-hint">Default 5002</span>
            </div>
          </div>
          {portError ? (
            <div id="port-error" className="settings-error" role="alert">
              {portError}
            </div>
          ) : null}
          {portChangedVsRunning ? (
            <div className="settings-warning" role="status">
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <WarnIcon />
                Port change takes effect on next server restart.
              </span>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleRestartServer}
                disabled={busy.restart}
              >
                {busy.restart ? 'Restarting…' : 'Restart Server Now'}
              </button>
            </div>
          ) : null}

          <div className="settings-row">
            <span className="settings-label">Host</span>
            <div className="settings-control">
              <code className="settings-readonly">127.0.0.1 (local only)</code>
              <span className="settings-hint">
                freekoko does not listen on external interfaces.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Generation defaults -------------------------------------------- */}
      <section
        className="settings-section"
        aria-labelledby="sec-generation"
      >
        <h3 id="sec-generation" className="settings-heading">
          Generation defaults
        </h3>
        <div className="settings-card">
          <div className="settings-row">
            <label className="settings-label" htmlFor="voice-select">
              Default voice
            </label>
            <div className="settings-control">
              <select
                id="voice-select"
                value={settings.defaultVoice}
                onChange={onVoiceChange}
              >
                {!knownVoice ? (
                  <option value={settings.defaultVoice}>
                    {settings.defaultVoice} (unknown)
                  </option>
                ) : null}
                {groupedVoices.map(([langLabel, list]) => (
                  <optgroup key={langLabel} label={langLabel}>
                    {list.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.gender}, {v.quality})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {voices.length === 0 ? (
                <span className="settings-hint">
                  Start the server to load the full voice list.
                </span>
              ) : null}
            </div>
          </div>

          <div className="settings-row">
            <label className="settings-label" htmlFor="speed-input">
              Default speed
            </label>
            <div className="settings-control">
              <input
                id="speed-input"
                type="number"
                min={SPEED_MIN}
                max={SPEED_MAX}
                step={SPEED_STEP}
                value={settings.defaultSpeed}
                onChange={onSpeedChange}
              />
              <span className="settings-hint">
                {settings.defaultSpeed.toFixed(1)}×
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Storage --------------------------------------------------------- */}
      <section className="settings-section" aria-labelledby="sec-storage">
        <h3 id="sec-storage" className="settings-heading">
          Storage
        </h3>
        <div className="settings-card">
          <div className="settings-row">
            <label className="settings-label" htmlFor="outputdir-input">
              Output directory
            </label>
            <div className="settings-control settings-control-inline">
              <input
                id="outputdir-input"
                type="text"
                value={settings.outputDir}
                readOnly
                onFocus={(e) => e.target.select()}
              />
              <button
                type="button"
                className="btn"
                onClick={handleChooseDirectory}
                disabled={busy.outputDir}
              >
                {busy.outputDir ? 'Choosing…' : 'Change…'}
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleOpenFolder}
              >
                Open Folder
              </button>
            </div>
          </div>
          <div className="settings-row">
            <span className="settings-label">History</span>
            <div className="settings-control">
              <span className="settings-hint">
                Recent generations are stored under{' '}
                <code>{settings.outputDir}</code>. Use the History tab to
                delete entries.
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* System ---------------------------------------------------------- */}
      <section className="settings-section" aria-labelledby="sec-system">
        <h3 id="sec-system" className="settings-heading">
          System
        </h3>
        <div className="settings-card">
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.launchOnLogin}
              onChange={onLaunchLoginChange}
            />
            <span>Launch freekoko at login</span>
          </label>
          <label className="settings-checkbox">
            <input
              type="checkbox"
              checked={settings.autoStartServer}
              onChange={onAutoStartChange}
            />
            <span>Automatically start the server when freekoko launches</span>
          </label>
        </div>
      </section>

      {/* About — rendered inline so anchor-scroll works ------------------ */}
      <About ref={aboutRef} />
    </section>
  );
}

// --- Helpers ----------------------------------------------------------

/**
 * 12px monochrome caution triangle — inherits color from the parent
 * `.settings-warning` (amber). Stroked, not filled, to match macOS
 * System-Settings-style inline notices.
 */
function WarnIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none' }}
    >
      <path d="M6 1.25 11 10.25 1 10.25 Z" />
      <path d="M6 5 V7.25" />
      <path d="M6 8.75 V8.75" />
    </svg>
  );
}

function groupVoicesByLanguage(
  voices: VoiceInfo[]
): [string, VoiceInfo[]][] {
  const map = new Map<string, VoiceInfo[]>();
  for (const v of voices) {
    const key = v.languageName || v.language || 'Other';
    const arr = map.get(key) ?? [];
    arr.push(v);
    map.set(key, arr);
  }
  // Sort within each group: quality A before B, then female before male,
  // then alphabetical.
  for (const [, list] of map) {
    list.sort((a, b) => {
      if (a.quality !== b.quality) return a.quality < b.quality ? -1 : 1;
      if (a.gender !== b.gender)
        return a.gender === 'Female' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }
  return Array.from(map.entries()).sort(([la], [lb]) => la.localeCompare(lb));
}
