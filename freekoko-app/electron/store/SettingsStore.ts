import path from 'node:path';
import { EventEmitter } from 'node:events';

import type { AppSettings } from '../types';

/**
 * Typed wrapper around electron-store. Broadcasts `changed` events via
 * its EventEmitter; the IPC layer wires these to `on:settings-changed`.
 *
 * We import `electron` and `electron-store` lazily so the module can be
 * imported by Vitest tests running outside Electron without blowing up.
 */

export const DEFAULT_PORT = 5002;

export function buildDefaults(userDataDir: string): AppSettings {
  return {
    port: DEFAULT_PORT,
    defaultVoice: 'af_heart',
    defaultSpeed: 1.0,
    autoStartServer: true,
    launchOnLogin: false,
    outputDir: path.join(userDataDir, 'history'),
  };
}

export interface StoreLike {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  store: Record<string, unknown>;
}

export class SettingsStore extends EventEmitter {
  private impl: StoreLike;
  private defaults: AppSettings;

  constructor(impl: StoreLike, defaults: AppSettings) {
    super();
    this.impl = impl;
    this.defaults = defaults;
    // Hydrate any missing keys with defaults.
    for (const [k, v] of Object.entries(defaults)) {
      if (this.impl.get(k) === undefined) {
        this.impl.set(k, v);
      }
    }
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    const v = this.impl.get<AppSettings[K]>(key as string);
    return (v === undefined ? this.defaults[key] : v) as AppSettings[K];
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): AppSettings {
    this.impl.set(key as string, value);
    const all = this.getAll();
    this.emit('changed', all);
    return all;
  }

  setMany(patch: Partial<AppSettings>): AppSettings {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      this.impl.set(k, v);
    }
    const all = this.getAll();
    this.emit('changed', all);
    return all;
  }

  getAll(): AppSettings {
    const out = { ...this.defaults };
    for (const k of Object.keys(this.defaults) as (keyof AppSettings)[]) {
      const v = this.impl.get(k as string);
      if (v !== undefined) (out as Record<string, unknown>)[k as string] = v;
    }
    return out;
  }
}

/**
 * Factory that wires up a real electron-store instance. Kept separate
 * so unit tests can bypass the electron-store dependency entirely.
 */
export async function createSettingsStore(userDataDir: string): Promise<SettingsStore> {
  const defaults = buildDefaults(userDataDir);
  // electron-store v10 is ESM-only — use dynamic import.
  const mod = (await import('electron-store')) as unknown as {
    default: new (opts: { defaults: AppSettings }) => StoreLike;
  };
  const Ctor = mod.default;
  const impl = new Ctor({ defaults });
  return new SettingsStore(impl, defaults);
}
