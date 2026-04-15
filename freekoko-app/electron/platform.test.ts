import { describe, expect, it } from 'vitest';

import {
  MIN_DARWIN_MAJOR,
  isCompatibleSystem,
  parseDarwinMajor,
  platformErrorMessage,
} from './platform';

describe('parseDarwinMajor', () => {
  it('reads the major kernel version', () => {
    expect(parseDarwinMajor('24.0.0')).toBe(24);
    expect(parseDarwinMajor('25.3.1')).toBe(25);
    expect(parseDarwinMajor('24')).toBe(24);
  });

  it('returns null for junk input', () => {
    expect(parseDarwinMajor('')).toBeNull();
    expect(parseDarwinMajor('abc.1.2')).toBeNull();
    // @ts-expect-error — ensure runtime guard
    expect(parseDarwinMajor(undefined)).toBeNull();
  });
});

describe('isCompatibleSystem', () => {
  it('accepts supported macOS 15 arm64', () => {
    const r = isCompatibleSystem('darwin', 'arm64', '24.3.0');
    expect(r.ok).toBe(true);
  });

  it('accepts future macOS versions (26+)', () => {
    const r = isCompatibleSystem('darwin', 'arm64', '25.0.0');
    expect(r.ok).toBe(true);
  });

  it('rejects non-darwin platforms', () => {
    const r = isCompatibleSystem('linux', 'arm64', '24.0.0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('platform');
  });

  it('rejects Intel Macs', () => {
    const r = isCompatibleSystem('darwin', 'x64', '24.0.0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('arch');
  });

  it('rejects Darwin 23 (macOS 14 Sonoma) as too old', () => {
    const r = isCompatibleSystem('darwin', 'arm64', '23.6.0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('version');
  });

  it('rejects Darwin 22 (macOS 13 Ventura) as too old', () => {
    const r = isCompatibleSystem('darwin', 'arm64', '22.0.0');
    expect(r.ok).toBe(false);
  });

  it('keeps the minimum constant at Darwin 24 (macOS 15)', () => {
    expect(MIN_DARWIN_MAJOR).toBe(24);
    const ok = isCompatibleSystem('darwin', 'arm64', `${MIN_DARWIN_MAJOR}.0.0`);
    expect(ok.ok).toBe(true);
    const tooOld = isCompatibleSystem(
      'darwin',
      'arm64',
      `${MIN_DARWIN_MAJOR - 1}.6.0`
    );
    expect(tooOld.ok).toBe(false);
  });

  it('rejects unparseable Darwin release strings', () => {
    const r = isCompatibleSystem('darwin', 'arm64', 'not-a-version');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('version');
  });

  it('platform check takes precedence over arch + version', () => {
    const r = isCompatibleSystem('win32', 'x64', '10.0.0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('platform');
  });

  it('arch check takes precedence over version when platform is darwin', () => {
    const r = isCompatibleSystem('darwin', 'ia32', '22.0.0');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('arch');
  });
});

describe('platformErrorMessage', () => {
  it('produces a title+detail for platform failures', () => {
    const r = isCompatibleSystem('linux', 'x64', '6.6.0');
    const msg = platformErrorMessage(r);
    expect(msg.title).toBe('Unsupported platform');
    expect(msg.detail).toMatch(/macOS/);
  });

  it('produces a title+detail for arch failures', () => {
    const r = isCompatibleSystem('darwin', 'x64', '24.0.0');
    const msg = platformErrorMessage(r);
    expect(msg.title).toBe('Unsupported architecture');
    expect(msg.detail).toMatch(/Apple Silicon/);
  });

  it('produces a title+detail for version failures', () => {
    const r = isCompatibleSystem('darwin', 'arm64', '22.0.0');
    const msg = platformErrorMessage(r);
    expect(msg.title).toBe('macOS 15 required');
    expect(msg.detail).toMatch(/Sequoia|15/);
  });

  it('returns empty strings when compatible', () => {
    const r = isCompatibleSystem('darwin', 'arm64', '24.0.0');
    const msg = platformErrorMessage(r);
    expect(msg.title).toBe('');
    expect(msg.detail).toBe('');
  });
});
