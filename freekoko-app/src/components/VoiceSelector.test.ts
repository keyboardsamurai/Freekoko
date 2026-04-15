import { describe, expect, it } from 'vitest';
import type { VoiceInfo } from '../lib/types';
import { groupVoices, sortVoices } from './VoiceSelector';

function v(opts: Partial<VoiceInfo> & Pick<VoiceInfo, 'id' | 'name'>): VoiceInfo {
  return {
    language: 'en-US',
    languageName: 'American English',
    gender: 'Female',
    quality: 'A',
    ...opts,
  };
}

describe('VoiceSelector.sortVoices', () => {
  it('sorts quality A before B within a language', () => {
    const out = sortVoices([
      v({ id: '1', name: 'Bella', quality: 'B' }),
      v({ id: '2', name: 'Heart', quality: 'A' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['2', '1']);
  });

  it('sorts female before male within the same quality', () => {
    const out = sortVoices([
      v({ id: 'm', name: 'Adam', gender: 'Male', quality: 'A' }),
      v({ id: 'f', name: 'Heart', gender: 'Female', quality: 'A' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['f', 'm']);
  });

  it('groups by language before applying quality/gender rules', () => {
    const out = sortVoices([
      v({ id: 'us', name: 'Adam', language: 'en-US' }),
      v({ id: 'gb', name: 'Alice', language: 'en-GB' }),
    ]);
    // en-GB < en-US lexically.
    expect(out.map((x) => x.id)).toEqual(['gb', 'us']);
  });
});

describe('VoiceSelector.groupVoices', () => {
  it('returns groups in sorted language order, each with sorted voices', () => {
    const groups = groupVoices([
      v({
        id: 'us-m-b',
        name: 'Adam',
        language: 'en-US',
        languageName: 'American English',
        gender: 'Male',
        quality: 'B',
      }),
      v({
        id: 'us-f-a',
        name: 'Heart',
        language: 'en-US',
        languageName: 'American English',
        gender: 'Female',
        quality: 'A',
      }),
      v({
        id: 'gb-m-a',
        name: 'George',
        language: 'en-GB',
        languageName: 'British English',
        gender: 'Male',
        quality: 'A',
      }),
    ]);
    expect(groups.map((g) => g.language)).toEqual(['en-GB', 'en-US']);
    expect(groups[1].voices.map((x) => x.id)).toEqual(['us-f-a', 'us-m-b']);
    expect(groups[0].languageName).toBe('British English');
  });
});
