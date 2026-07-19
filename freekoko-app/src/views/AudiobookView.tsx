import { useEffect, useMemo, useState } from 'react';
import { VoiceSelector } from '../components/VoiceSelector';
import { SpeedSlider } from '../components/SpeedSlider';
import {
  chooseAudiobookFiles,
  chooseDirectory,
  openPath,
  startAudiobook,
  cancelAudiobook,
  onAudiobookProgress,
  getAllSettings,
  listVoices,
  isIpcError,
} from '../lib/ipc';
import type { AudiobookProgressEvent, AudiobookResult, VoiceInfo } from '../lib/types';
import { useAppStore } from '../store/useAppStore';

/** Last path segment, tolerant of both separators. */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function AudiobookView() {
  const status = useAppStore((s) => s.status);
  const serverRunning = status.state === 'running';

  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1.0);

  const [files, setFiles] = useState<string[]>([]);
  const [outDir, setOutDir] = useState('');

  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [progress, setProgress] = useState<Record<number, AudiobookProgressEvent>>({});
  const [summary, setSummary] = useState<AudiobookResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load voices + defaults once.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [vs, settings] = await Promise.all([listVoices(), getAllSettings()]);
      if (!alive) return;
      if (!isIpcError(vs)) setVoices(vs);
      const preferred = settings.defaultVoice;
      const avail = isIpcError(vs) ? [] : vs;
      setVoice(
        avail.some((v) => v.id === preferred)
          ? preferred
          : avail[0]?.id ?? preferred
      );
      setSpeed(settings.defaultSpeed);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Single job at a time, so one unfiltered subscription is enough.
  useEffect(() => {
    const off = onAudiobookProgress((e) => {
      setProgress((prev) => ({ ...prev, [e.fileIndex]: e }));
    });
    return () => off();
  }, []);

  const running = phase === 'running';

  const current = useMemo(() => {
    const entries = Object.values(progress).filter((e) => e.status === 'running');
    return entries.length ? entries[entries.length - 1] : null;
  }, [progress]);

  async function handleChooseFiles() {
    const res = await chooseAudiobookFiles();
    if (isIpcError(res)) {
      setError(res.message ?? res.error);
      return;
    }
    if (res.length) {
      setFiles(res);
      setProgress({});
      setSummary(null);
      setError(null);
    }
  }

  async function handleChooseFolder() {
    const res = await chooseDirectory(outDir || undefined);
    if (isIpcError(res)) {
      setError(res.message ?? res.error);
      return;
    }
    if (res.ok) setOutDir(res.path);
  }

  async function handleStart() {
    setError(null);
    setSummary(null);
    setProgress({});
    setPhase('running');
    const res = await startAudiobook({ files, outDir, voice, speed });
    setPhase('done');
    if (isIpcError(res)) {
      setError(res.message ?? res.error);
      return;
    }
    setSummary(res);
  }

  const canStart = serverRunning && files.length > 0 && !!outDir && !!voice && !running;

  return (
    <section className="view audiobook-view">
      <h2>Audiobook</h2>
      <p className="muted">
        Convert a set of text files into numbered audio files &mdash; one WAV per
        file, in filename order. Re-running the same job skips files already done.
      </p>

      {!serverRunning && (
        <div className="banner banner-warn">
          Server is {status.state}. Start it from the tray to enable generation.
        </div>
      )}

      {error && (
        <div className="banner banner-error">
          <span>{error}</span>
          <button
            type="button"
            className="banner-close"
            onClick={() => setError(null)}
            aria-label="Dismiss"
          >
            {'×'}
          </button>
        </div>
      )}

      <div className="generate-row" style={{ gap: 8 }}>
        <button type="button" className="btn-generate" onClick={handleChooseFiles} disabled={running}>
          Choose text files{'…'}
        </button>
        <button type="button" className="btn-generate" onClick={handleChooseFolder} disabled={running}>
          Choose output folder{'…'}
        </button>
      </div>

      {outDir && (
        <span className="text-meta">
          Output: <span className="text-meta-value">{outDir}</span>
        </span>
      )}

      {files.length > 0 && (
        <ol className="audiobook-files" style={{ margin: '12px 0', paddingLeft: 20 }}>
          {files.map((f, i) => {
            const st = progress[i]?.status;
            const mark =
              st === 'done' ? '✓' : st === 'skipped' ? '↷' : st === 'error' ? '✗' : st === 'running' ? '…' : '';
            return (
              <li key={f} className="muted" title={progress[i]?.message}>
                {baseName(f)} {mark}
              </li>
            );
          })}
        </ol>
      )}

      <div className="controls-row">
        <div className="control-voice">
          <label className="field-label">Voice</label>
          <VoiceSelector value={voice} voices={voices} onChange={setVoice} disabled={running} />
        </div>
        <div className="control-speed">
          <SpeedSlider value={speed} onChange={setSpeed} disabled={running} />
        </div>
      </div>

      <div className="generate-row">
        {running ? (
          <button type="button" className="btn-generate btn-danger" onClick={cancelAudiobook} aria-busy>
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden focusable="false">
              <rect x="3" y="3" width="6" height="6" fill="currentColor" />
            </svg>
            <span>Stop</span>
          </button>
        ) : (
          <button type="button" className="btn-generate" onClick={handleStart} disabled={!canStart}>
            <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden focusable="false">
              <path d="M3 2l7 4-7 4z" fill="currentColor" />
            </svg>
            <span>Convert to audiobook</span>
          </button>
        )}
      </div>

      {running && (
        <div className="progress-row" role="status" aria-live="polite">
          <span className="spinner" aria-hidden />
          <span className="muted">
            {current
              ? `Chapter ${current.fileIndex + 1} / ${current.total}` +
                (current.chunkTotal
                  ? ` · chunk ${(current.chunkIndex ?? 0) + 1}/${current.chunkTotal}`
                  : '')
              : 'Starting…'}
          </span>
        </div>
      )}

      {phase === 'done' && summary && (
        <div className="progress-row" role="status" aria-live="polite">
          <span className="muted">
            {summary.cancelled ? 'Stopped. ' : 'Done. '}
            {summary.written} written{summary.skipped ? `, ${summary.skipped} skipped` : ''}.
          </span>
          {outDir && (
            <button type="button" className="btn-generate" onClick={() => openPath(outDir)}>
              Reveal output folder
            </button>
          )}
        </div>
      )}
    </section>
  );
}
