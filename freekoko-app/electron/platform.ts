/**
 * Pure compatibility checks for freekoko.
 *
 * Separated from main.ts so it can be unit-tested without booting Electron.
 *
 *   Darwin kernel → macOS map (relevant entries):
 *     22.x → macOS 13 Ventura
 *     23.x → macOS 14 Sonoma
 *     24.x → macOS 15 Sequoia  (minimum required — MLX Swift baseline)
 *     25.x → macOS 16+
 */

export const MIN_DARWIN_MAJOR = 24;

export type CompatibilityResult =
  | { ok: true }
  | { ok: false; reason: 'platform'; detail: string }
  | { ok: false; reason: 'arch'; detail: string }
  | { ok: false; reason: 'version'; detail: string };

/** Extract the major kernel version from an `os.release()` string like "24.3.0". */
export function parseDarwinMajor(release: string): number | null {
  if (typeof release !== 'string' || !release) return null;
  const head = release.split('.')[0];
  const n = Number.parseInt(head, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Evaluate whether the current runtime is supported by freekoko.
 * Order of checks matches the user-facing error priority:
 *   1. macOS only (platform === 'darwin')
 *   2. Apple Silicon only (arch === 'arm64')
 *   3. macOS 15+ (Darwin >= 24)
 */
export function isCompatibleSystem(
  platform: string,
  arch: string,
  darwinRelease: string
): CompatibilityResult {
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: 'platform',
      detail: `Unsupported platform "${platform}". freekoko requires macOS.`,
    };
  }
  if (arch !== 'arm64') {
    return {
      ok: false,
      reason: 'arch',
      detail: `Unsupported architecture "${arch}". freekoko requires Apple Silicon (M1 / M2 / M3 / M4). Intel Macs are not supported.`,
    };
  }
  const major = parseDarwinMajor(darwinRelease);
  if (major == null) {
    return {
      ok: false,
      reason: 'version',
      detail: `Could not parse Darwin release "${darwinRelease}".`,
    };
  }
  if (major < MIN_DARWIN_MAJOR) {
    return {
      ok: false,
      reason: 'version',
      detail: `freekoko requires macOS 15.0 (Sequoia) or later. You are running Darwin ${darwinRelease}.`,
    };
  }
  return { ok: true };
}

/** Translate a failure result into a user-visible (title, detail) pair. */
export function platformErrorMessage(result: CompatibilityResult): {
  title: string;
  detail: string;
} {
  if (result.ok) {
    return { title: '', detail: '' };
  }
  switch (result.reason) {
    case 'platform':
      return { title: 'Unsupported platform', detail: result.detail };
    case 'arch':
      return { title: 'Unsupported architecture', detail: result.detail };
    case 'version':
      return { title: 'macOS 15 required', detail: result.detail };
    default:
      return { title: 'Unsupported system', detail: 'Unknown compatibility failure.' };
  }
}
