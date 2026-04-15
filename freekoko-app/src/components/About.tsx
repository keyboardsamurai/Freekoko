import { forwardRef, useEffect, useState } from 'react';
import { getAppVersion, openUrl } from '../lib/ipc';

const REPO_URL = 'https://github.com/antonio-agudo/freekoko';
const MODEL_URL = 'https://huggingface.co/hexgrad/Kokoro-82M';
const KOKORO_SWIFT_URL = 'https://github.com/keyboardsamurai/kokoro-voice';
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

interface AboutProps {
  id?: string;
}

/**
 * Inline About section rendered inside SettingsView.
 *
 * The tray / app menu "About freekoko" items deep-link here by broadcasting
 * `on:navigate` with `{ tab: 'settings', section: 'about' }` — SettingsView
 * uses a ref to scroll this section into view on that event.
 */
export const About = forwardRef<HTMLElement, AboutProps>(function About(
  { id = 'about' }: AboutProps,
  ref
) {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    let alive = true;
    getAppVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {
        /* best-effort */
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleLink = (url: string) => (evt: React.MouseEvent) => {
    evt.preventDefault();
    void openUrl(url);
  };

  return (
    <section id={id} ref={ref} className="settings-section">
      <h3 className="settings-heading">About</h3>
      <div className="settings-card about-card">
        <div className="about-title">
          freekoko{version ? ` · v${version}` : ''}
        </div>
        <p className="about-desc">
          Open-source, MIT-licensed, local-first Kokoro TTS for macOS.
        </p>
        <p className="about-privacy">
          Fully offline. Zero telemetry. No analytics, no network calls after
          install.
        </p>
        <dl className="about-credits">
          <dt>Kokoro model</dt>
          <dd>
            <a href={MODEL_URL} onClick={handleLink(MODEL_URL)}>
              hexgrad / Kokoro-82M
            </a>{' '}
            — Apache 2.0
          </dd>
          <dt>Swift core</dt>
          <dd>
            <a
              href={KOKORO_SWIFT_URL}
              onClick={handleLink(KOKORO_SWIFT_URL)}
            >
              keyboardsamurai / kokoro-voice
            </a>{' '}
            — MIT
          </dd>
          <dt>App</dt>
          <dd>freekoko contributors — MIT</dd>
        </dl>
        <div className="about-links">
          <a href={REPO_URL} onClick={handleLink(REPO_URL)}>
            GitHub
          </a>
          <span className="about-sep">·</span>
          <a href={LICENSE_URL} onClick={handleLink(LICENSE_URL)}>
            MIT License
          </a>
          <span className="about-sep">·</span>
          <a href={MODEL_URL} onClick={handleLink(MODEL_URL)}>
            Model
          </a>
        </div>
      </div>
    </section>
  );
});
