import { describe, expect, it } from 'vitest';
import { LogCapture } from './LogCapture';

describe('LogCapture', () => {
  it('parses well-formed JSON log lines', () => {
    const lc = new LogCapture();
    const entry = lc.ingestLine(
      '{"ts":"2026-04-14T10:23:41.123Z","level":"info","msg":"server_started","port":5002}'
    );
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('server_started');
    expect(entry.port).toBe(5002);
    expect(entry.ts).toBe('2026-04-14T10:23:41.123Z');
  });

  it('wraps non-JSON lines as raw info entries', () => {
    const lc = new LogCapture();
    const entry = lc.ingestLine('this is a raw stack trace line');
    expect(entry.level).toBe('info');
    expect(entry.event).toBe('raw');
    expect(entry.msg).toBe('this is a raw stack trace line');
  });

  it('promotes stderr raw lines to error level', () => {
    const lc = new LogCapture();
    const entry = lc.ingestLine('segfault!', 'stderr');
    expect(entry.level).toBe('error');
    expect(entry.event).toBe('raw');
  });

  it('caps the ring buffer at 1000 entries', () => {
    const lc = new LogCapture();
    for (let i = 0; i < 1500; i++) {
      lc.ingestLine(`{"ts":"x","level":"info","msg":"m${i}"}`);
    }
    const recent = lc.recent();
    expect(recent.length).toBe(1000);
    expect(recent[0]?.msg).toBe('m500');
    expect(recent[recent.length - 1]?.msg).toBe('m1499');
  });

  it('recent(limit) returns the tail slice', () => {
    const lc = new LogCapture();
    for (let i = 0; i < 5; i++) {
      lc.ingestLine(`{"ts":"x","level":"info","msg":"m${i}"}`);
    }
    const last3 = lc.recent(3);
    expect(last3.map((e) => e.msg)).toEqual(['m2', 'm3', 'm4']);
  });

  it('normalizes unknown log levels to info', () => {
    const lc = new LogCapture();
    const entry = lc.ingestLine('{"ts":"x","level":"NOPE","msg":"m"}');
    expect(entry.level).toBe('info');
  });

  it('invokes onEntry callback with each parsed entry', () => {
    const seen: string[] = [];
    const lc = new LogCapture({ onEntry: (e) => seen.push(e.msg) });
    lc.ingestLine('{"ts":"x","level":"info","msg":"one"}');
    lc.ingestLine('{"ts":"x","level":"info","msg":"two"}');
    expect(seen).toEqual(['one', 'two']);
  });
});
