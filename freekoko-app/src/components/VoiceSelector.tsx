import { useMemo } from 'react';
import type { VoiceInfo } from '../lib/types';

interface Props {
  value: string;
  voices: VoiceInfo[];
  onChange: (id: string) => void;
  disabled?: boolean;
}

const FLAG: Record<string, string> = {
  'en-US': '\uD83C\uDDFA\uD83C\uDDF8',
  'en-GB': '\uD83C\uDDEC\uD83C\uDDE7',
  'es-ES': '\uD83C\uDDEA\uD83C\uDDF8',
  'it-IT': '\uD83C\uDDEE\uD83C\uDDF9',
  'pt-BR': '\uD83C\uDDE7\uD83C\uDDF7',
  'fr-FR': '\uD83C\uDDEB\uD83C\uDDF7',
  'de-DE': '\uD83C\uDDE9\uD83C\uDDEA',
  'ja-JP': '\uD83C\uDDEF\uD83C\uDDF5',
  'zh-CN': '\uD83C\uDDE8\uD83C\uDDF3',
};

function flag(lang: string): string {
  return FLAG[lang] ?? '\uD83C\uDFF3'; // white flag fallback
}

/**
 * Pure sorter exported for unit tests.
 * Orders by language (grouped) then quality A before B,
 * then female before male.
 */
export function sortVoices(voices: VoiceInfo[]): VoiceInfo[] {
  return [...voices].sort((a, b) => {
    if (a.language !== b.language) return a.language.localeCompare(b.language);
    if (a.quality !== b.quality) return a.quality === 'A' ? -1 : 1;
    if (a.gender !== b.gender) return a.gender === 'Female' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Groups voices by language while preserving the sort order returned
 * by `sortVoices`.
 */
export function groupVoices(
  voices: VoiceInfo[]
): { language: string; languageName: string; voices: VoiceInfo[] }[] {
  const sorted = sortVoices(voices);
  const groups: {
    language: string;
    languageName: string;
    voices: VoiceInfo[];
  }[] = [];
  for (const v of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.language === v.language) {
      last.voices.push(v);
    } else {
      groups.push({
        language: v.language,
        languageName: v.languageName || v.language,
        voices: [v],
      });
    }
  }
  return groups;
}

export function VoiceSelector({ value, voices, onChange, disabled }: Props) {
  const groups = useMemo(() => groupVoices(voices), [voices]);
  return (
    <select
      className="voice-select"
      aria-label="Voice"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || voices.length === 0}
    >
      {voices.length === 0 && <option value="">No voices loaded</option>}
      {groups.map((g) => (
        <optgroup key={g.language} label={g.languageName}>
          {g.voices.map((v) => (
            <option key={v.id} value={v.id}>
              {flag(v.language)} {v.name} ({v.quality})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
