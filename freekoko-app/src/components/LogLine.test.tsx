// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { LogLine } from './LogLine';
import type { LogEntry } from '../lib/types';

function makeEntry(level: LogEntry['level'], extra: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: '2026-04-14T10:23:41.100Z',
    level,
    msg: 'hello',
    event: 'server_started',
    ...extra,
  };
}

afterEach(() => cleanup());

describe('LogLine', () => {
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    it(`renders a ${level} level badge with the correct class`, () => {
      const { container } = render(<LogLine entry={makeEntry(level)} />);
      const root = container.querySelector('.log-line') as HTMLElement;
      expect(root).toBeTruthy();
      expect(root.classList.contains(`log-${level}`)).toBe(true);
      const badge = container.querySelector('.log-level') as HTMLElement;
      expect(badge.classList.contains(`log-level-${level}`)).toBe(true);
      expect(badge.textContent).toBe(level.toUpperCase());
    });
  }

  it('renders the formatted timestamp', () => {
    const { container } = render(
      <LogLine entry={makeEntry('info', { ts: '2026-04-14T10:23:41.100Z' })} />
    );
    const ts = container.querySelector('.log-ts') as HTMLElement;
    expect(ts.textContent).toBe('10:23:41.100');
  });

  it('renders event and message columns', () => {
    const { container } = render(
      <LogLine entry={makeEntry('info', { event: 'model_loaded', msg: 'voices=36' })} />
    );
    expect(container.querySelector('.log-event')?.textContent).toBe('model_loaded');
    expect(container.querySelector('.log-msg')?.textContent).toBe('voices=36');
  });

  it('renders extra fields as key=value', () => {
    const { container } = render(
      <LogLine
        entry={makeEntry('info', { msg: 'POST /tts', voice: 'af_heart', status: 200 })}
      />
    );
    const fields = container.querySelector('.log-fields')?.textContent ?? '';
    expect(fields).toContain('voice=af_heart');
    expect(fields).toContain('status=200');
  });
});
