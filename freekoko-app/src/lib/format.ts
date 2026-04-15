// Small zero-dependency formatting helpers. Intentionally NOT pulling in
// date-fns or Intl.RelativeTimeFormat — we only need a handful of
// buckets and a consistent output. Duplicating a shared utility here
// keeps the component tree free of circular deps with P3-owned files.

export function formatRelativeTime(ts: string | number | Date, now: Date = new Date()): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const diffMs = now.getTime() - d.getTime();
  const future = diffMs < 0;
  const absMs = Math.abs(diffMs);
  const s = Math.round(absMs / 1000);

  const bucket = (value: number, singular: string, plural: string) => {
    const label = `${value} ${value === 1 ? singular : plural}`;
    return future ? `in ${label}` : `${label} ago`;
  };

  if (s < 5) return 'just now';
  if (s < 60) return bucket(s, 'second', 'seconds');
  const m = Math.round(s / 60);
  if (m < 60) return bucket(m, 'minute', 'minutes');
  const h = Math.round(m / 60);
  if (h < 24) return bucket(h, 'hour', 'hours');
  const days = Math.round(h / 24);
  if (days < 30) return bucket(days, 'day', 'days');
  const months = Math.round(days / 30);
  if (months < 12) return bucket(months, 'month', 'months');
  const years = Math.round(months / 12);
  return bucket(years, 'year', 'years');
}

export function formatAbsoluteTime(ts: string | number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

export function truncate(text: string, max = 120): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

// Voice ID → display badge. Kokoro convention: first letter = language
// group (a=American English, b=British English, …), second letter =
// gender (f/m), rest = voice name. Quality follows "A" for all first-party
// voices. We duplicate this mapping rather than share with GenerateView
// to avoid circular deps between P3/P4 (acknowledged).
const LANGUAGE_FLAGS: Record<string, { flag: string; name: string }> = {
  a: { flag: '🇺🇸', name: 'American English' },
  b: { flag: '🇬🇧', name: 'British English' },
  e: { flag: '🇪🇸', name: 'Spanish' },
  f: { flag: '🇫🇷', name: 'French' },
  h: { flag: '🇮🇳', name: 'Hindi' },
  i: { flag: '🇮🇹', name: 'Italian' },
  j: { flag: '🇯🇵', name: 'Japanese' },
  p: { flag: '🇧🇷', name: 'Brazilian Portuguese' },
  z: { flag: '🇨🇳', name: 'Mandarin Chinese' },
};

export interface VoiceBadge {
  flag: string;
  languageName: string;
  displayName: string;
  gender: 'Female' | 'Male' | 'Unknown';
}

export function parseVoiceId(voiceId: string): VoiceBadge {
  if (!voiceId || voiceId.length < 3) {
    return {
      flag: '🗣',
      languageName: 'Unknown',
      displayName: voiceId || 'unknown',
      gender: 'Unknown',
    };
  }
  const langKey = voiceId[0]!.toLowerCase();
  const genderKey = voiceId[1]!.toLowerCase();
  const rest = voiceId.slice(3);
  const lang = LANGUAGE_FLAGS[langKey] ?? { flag: '🗣', name: 'Unknown' };
  const gender: VoiceBadge['gender'] =
    genderKey === 'f' ? 'Female' : genderKey === 'm' ? 'Male' : 'Unknown';
  const displayName = rest ? rest[0]!.toUpperCase() + rest.slice(1) : voiceId;
  return {
    flag: lang.flag,
    languageName: lang.name,
    displayName,
    gender,
  };
}
