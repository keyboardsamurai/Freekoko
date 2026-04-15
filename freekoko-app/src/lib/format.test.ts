import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatRelativeTime,
  parseVoiceId,
  truncate,
} from './format';

describe('formatRelativeTime', () => {
  const now = new Date('2026-04-14T12:00:00Z');

  it('returns "just now" for timestamps within 5 seconds', () => {
    expect(formatRelativeTime('2026-04-14T11:59:58Z', now)).toBe('just now');
    expect(formatRelativeTime(now, now)).toBe('just now');
  });

  it('returns seconds for <60s', () => {
    expect(formatRelativeTime('2026-04-14T11:59:30Z', now)).toBe('30 seconds ago');
  });

  it('returns minutes for <60m', () => {
    expect(formatRelativeTime('2026-04-14T11:57:00Z', now)).toBe('3 minutes ago');
  });

  it('uses singular for exactly 1 minute', () => {
    expect(formatRelativeTime('2026-04-14T11:59:00Z', now)).toBe('1 minute ago');
  });

  it('returns hours for <24h', () => {
    expect(formatRelativeTime('2026-04-14T09:00:00Z', now)).toBe('3 hours ago');
  });

  it('returns days for <30d', () => {
    expect(formatRelativeTime('2026-04-10T12:00:00Z', now)).toBe('4 days ago');
  });

  it('returns "unknown" for invalid input', () => {
    expect(formatRelativeTime('not a date', now)).toBe('unknown');
  });
});

describe('formatDuration', () => {
  it('formats seconds and zero-pads', () => {
    expect(formatDuration(5000)).toBe('0:05');
    expect(formatDuration(65000)).toBe('1:05');
    expect(formatDuration(0)).toBe('0:00');
  });

  it('guards NaN / negative', () => {
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(-1)).toBe('0:00');
  });
});

describe('truncate', () => {
  it('returns input unchanged when below limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates and appends ellipsis', () => {
    const out = truncate('a'.repeat(200), 10);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(10);
  });
});

describe('parseVoiceId', () => {
  it('parses American female', () => {
    const v = parseVoiceId('af_heart');
    expect(v.flag).toBe('🇺🇸');
    expect(v.languageName).toBe('American English');
    expect(v.gender).toBe('Female');
    expect(v.displayName).toBe('Heart');
  });

  it('parses British male', () => {
    const v = parseVoiceId('bm_george');
    expect(v.flag).toBe('🇬🇧');
    expect(v.gender).toBe('Male');
    expect(v.displayName).toBe('George');
  });

  it('handles unknown ids', () => {
    const v = parseVoiceId('');
    expect(v.gender).toBe('Unknown');
    expect(v.displayName).toBe('unknown');
  });
});
