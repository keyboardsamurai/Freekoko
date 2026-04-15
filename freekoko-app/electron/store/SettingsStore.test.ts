import { describe, expect, it, vi } from 'vitest';
import { SettingsStore, buildDefaults, type StoreLike } from './SettingsStore';

function makeInMemoryStore(): StoreLike {
  const backing: Record<string, unknown> = {};
  return {
    get<T>(key: string): T | undefined {
      return backing[key] as T | undefined;
    },
    set(key: string, value: unknown) {
      backing[key] = value;
    },
    get store(): Record<string, unknown> {
      return backing;
    },
  };
}

describe('SettingsStore', () => {
  it('returns defaults when the backing store is empty', () => {
    const defaults = buildDefaults('/tmp/freekoko-test');
    const store = new SettingsStore(makeInMemoryStore(), defaults);
    expect(store.getAll()).toEqual(defaults);
    expect(store.get('port')).toBe(5002);
    expect(store.get('defaultVoice')).toBe('af_heart');
    expect(store.get('autoStartServer')).toBe(true);
    expect(store.get('launchOnLogin')).toBe(false);
    expect(store.get('defaultSpeed')).toBe(1.0);
    expect(store.get('outputDir')).toContain('history');
  });

  it('persists writes and returns them from get()', () => {
    const defaults = buildDefaults('/tmp/freekoko-test');
    const store = new SettingsStore(makeInMemoryStore(), defaults);
    store.set('port', 5050);
    expect(store.get('port')).toBe(5050);
    expect(store.getAll().port).toBe(5050);
  });

  it('emits a changed event on set()', () => {
    const defaults = buildDefaults('/tmp/freekoko-test');
    const store = new SettingsStore(makeInMemoryStore(), defaults);
    const spy = vi.fn();
    store.on('changed', spy);
    store.set('defaultSpeed', 1.25);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0].defaultSpeed).toBe(1.25);
  });

  it('supports partial updates via setMany()', () => {
    const defaults = buildDefaults('/tmp/freekoko-test');
    const store = new SettingsStore(makeInMemoryStore(), defaults);
    const spy = vi.fn();
    store.on('changed', spy);
    store.setMany({ port: 5099, defaultVoice: 'bf_alice' });
    expect(store.get('port')).toBe(5099);
    expect(store.get('defaultVoice')).toBe('bf_alice');
    // Unchanged keys remain at defaults.
    expect(store.get('defaultSpeed')).toBe(1.0);
    expect(spy).toHaveBeenCalledOnce();
  });
});
