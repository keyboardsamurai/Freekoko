// Captures a screenshot of the Generate view with Moby Dick's opening prefilled.
// Output: <repo-root>/screens/generate.png
//
// How it works:
//   1. Launches the built Electron app (out/main/index.js) via Playwright's
//      _electron API, passing FREEKOKO_SCREENSHOT_MODE=1 so main.ts reveals
//      the otherwise-hidden menubar window on startup.
//   2. A fresh temp --user-data-dir keeps the run independent of the
//      developer's real freekoko settings/history.
//   3. Waits for the textarea, fills it, waits briefly for any server/voice
//      hydration, then snaps the window.
//
// Run via: npm run screenshot  (or make screenshot from the repo root)

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appDir, '..');
const screensDir = path.join(repoRoot, 'screens');
const outputFile = path.join(screensDir, 'generate.png');

const MOBY_DICK_OPENING =
  'Call me Ishmael. Some years ago\u2014never mind how long precisely\u2014having little or no money in my purse, and nothing particular to interest me on shore, I thought I would sail about a little and see the watery part of the world. It is a way I have of driving off the spleen and regulating the circulation.';

fs.mkdirSync(screensDir, { recursive: true });
const userDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'freekoko-screenshot-')
);

const mainEntry = path.join(appDir, 'out', 'main', 'index.js');
if (!fs.existsSync(mainEntry)) {
  console.error(
    `Missing ${mainEntry}. Run "npm run build" (or "make app") first.`
  );
  process.exit(1);
}

// Point the supervisor at the Release binary produced by `make sidecar`.
// The supervisor's own dev fallback looks for a Debug build that this tree
// never produces; overriding keeps the screenshot workflow decoupled from
// `make dev`.
const sidecarBin = path.join(
  repoRoot,
  'freekoko-sidecar',
  '.build',
  'xcode-release',
  'Build',
  'Products',
  'Release',
  'freekoko-sidecar'
);
if (!fs.existsSync(sidecarBin)) {
  console.error(
    `Missing ${sidecarBin}. Run "make sidecar" (or "make dmg-dir") first.`
  );
  process.exit(1);
}

const app = await electron.launch({
  args: [mainEntry, `--user-data-dir=${userDataDir}`],
  cwd: appDir,
  env: {
    ...process.env,
    FREEKOKO_SCREENSHOT_MODE: '1',
    FREEKOKO_SIDECAR_BIN: sidecarBin,
    NODE_ENV: 'production',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  const textarea = page.locator('#tts-text');
  await textarea.waitFor({ state: 'visible', timeout: 20_000 });

  await textarea.fill(MOBY_DICK_OPENING);

  // Wait for the sidecar to reach 'running' state so the voice list populates
  // and the "Server is error/idle" banner is gone. Model load takes ~5-15 s.
  try {
    await page
      .locator('.status-badge.status-running')
      .waitFor({ state: 'visible', timeout: 45_000 });
  } catch {
    console.warn(
      'Sidecar did not reach running state within 45 s; capturing anyway.'
    );
  }

  // Blur so the caret/focus ring doesn't distort the screenshot.
  await page.locator('body').click({ position: { x: 2, y: 2 } });

  // Give the voice list one final moment to hydrate after 'running'.
  await page.waitForTimeout(1500);

  await page.screenshot({ path: outputFile, type: 'png' });
  console.log(`Wrote ${path.relative(repoRoot, outputFile)}`);
} finally {
  await app.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
