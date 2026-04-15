import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { VoiceInfo } from '../lib/types';
import './VoiceSelector.css';

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

function genderLetter(g: VoiceInfo['gender']): string {
  return g === 'Female' ? 'F' : 'M';
}

function ChevronIcon() {
  return (
    <svg
      className="voice-selector__chevron"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 3.75L5 6.75L8 3.75"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="voice-selector__check"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 7.25L5.75 10L11 4.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function VoiceSelector({ value, voices, onChange, disabled }: Props) {
  const groups = useMemo(() => groupVoices(voices), [voices]);

  // Flat list of voices in display order — what keyboard nav traverses.
  const flatVoices = useMemo(
    () => groups.flatMap((g) => g.voices),
    [groups]
  );

  const isDisabled = disabled || voices.length === 0;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(() => {
    const i = flatVoices.findIndex((v) => v.id === value);
    return i >= 0 ? i : 0;
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  const reactId = useId();
  const listboxId = `voice-selector-listbox-${reactId}`;
  const optionId = (index: number) => `voice-selector-opt-${reactId}-${index}`;

  const selected = flatVoices.find((v) => v.id === value);

  // Keep activeIndex aligned with current value when closed.
  useEffect(() => {
    if (open) return;
    const i = flatVoices.findIndex((v) => v.id === value);
    if (i >= 0) setActiveIndex(i);
  }, [value, flatVoices, open]);

  // Reset ref array size when voice list changes.
  useEffect(() => {
    optionRefs.current = optionRefs.current.slice(0, flatVoices.length);
  }, [flatVoices.length]);

  // Outside click — close.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // On open: scroll active option into view + focus the listbox so
  // aria-activedescendant is announced by VoiceOver.
  useLayoutEffect(() => {
    if (!open) return;
    const el = optionRefs.current[activeIndex];
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
    listboxRef.current?.focus({ preventScroll: true });
    // We only want this to fire on open transitions, not every active change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // When active changes while open, keep it in view.
  useEffect(() => {
    if (!open) return;
    const el = optionRefs.current[activeIndex];
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const commit = useCallback(
    (index: number) => {
      const v = flatVoices[index];
      if (!v) return;
      if (v.id !== value) onChange(v.id);
      setOpen(false);
      // Return focus to trigger for clean keyboard loop.
      requestAnimationFrame(() => triggerRef.current?.focus());
    },
    [flatVoices, onChange, value]
  );

  const closeAndReturnFocus = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const openWithValue = useCallback(() => {
    if (isDisabled) return;
    const i = flatVoices.findIndex((v) => v.id === value);
    setActiveIndex(i >= 0 ? i : 0);
    setOpen(true);
  }, [flatVoices, isDisabled, value]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (isDisabled) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        e.preventDefault();
        openWithValue();
        break;
      case 'Home':
        if (open) {
          e.preventDefault();
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (open) {
          e.preventDefault();
          setActiveIndex(flatVoices.length - 1);
        }
        break;
    }
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) =>
          flatVoices.length === 0 ? 0 : (i + 1) % flatVoices.length
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) =>
          flatVoices.length === 0
            ? 0
            : (i - 1 + flatVoices.length) % flatVoices.length
        );
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(flatVoices.length - 1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        closeAndReturnFocus();
        break;
      case 'Tab':
        // Treat tabbing out like a soft dismiss; don't trap focus.
        setOpen(false);
        break;
    }
  };

  // Build a flat-index map so grouped rendering can reference the right id.
  let flatCursor = -1;

  return (
    <div className="voice-selector" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="voice-select voice-selector__trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-disabled={isDisabled || undefined}
        aria-activedescendant={
          open && flatVoices[activeIndex]
            ? optionId(activeIndex)
            : undefined
        }
        aria-label="Voice"
        disabled={isDisabled}
        onClick={() => (open ? setOpen(false) : openWithValue())}
        onKeyDown={onTriggerKeyDown}
      >
        {selected ? (
          <span className="voice-selector__label">
            <span className="voice-selector__flag" aria-hidden="true">
              {flag(selected.language)}
            </span>
            <span className="voice-selector__label-name">{selected.name}</span>
            <span className="voice-selector__label-meta" aria-hidden="true">
              ({genderLetter(selected.gender)} &middot; {selected.quality})
            </span>
          </span>
        ) : (
          <span className="voice-selector__label voice-selector__label--empty">
            {voices.length === 0 ? 'No voices loaded' : 'Select a voice'}
          </span>
        )}
        <ChevronIcon />
      </button>

      {open && (
        <div
          className="voice-selector__popover"
          role="presentation"
          // Prevent the outside-click handler from firing when the user
          // mousedowns on the scrollbar / padding of the popover itself.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <ul
            ref={listboxRef}
            id={listboxId}
            className="voice-selector__listbox"
            role="listbox"
            tabIndex={-1}
            aria-label="Voice"
            aria-activedescendant={
              flatVoices[activeIndex] ? optionId(activeIndex) : undefined
            }
            onKeyDown={onListKeyDown}
          >
            {flatVoices.length === 0 && (
              <li className="voice-selector__empty" role="option" aria-selected="false">
                No voices loaded
              </li>
            )}
            {groups.map((g) => (
              <li key={g.language} className="voice-selector__group">
                <div
                  className="voice-selector__group-label"
                  role="presentation"
                >
                  {g.languageName}
                </div>
                <ul role="presentation" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {g.voices.map((v) => {
                    flatCursor += 1;
                    const idx = flatCursor;
                    const isActive = idx === activeIndex;
                    const isSelected = v.id === value;
                    const cls = [
                      'voice-selector__option',
                      isActive && 'voice-selector__option--active',
                      isSelected && 'voice-selector__option--selected',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <li
                        key={v.id}
                        id={optionId(idx)}
                        ref={(el) => {
                          optionRefs.current[idx] = el;
                        }}
                        role="option"
                        aria-selected={isSelected}
                        className={cls}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onMouseDown={(e) => {
                          // Prevent the listbox from losing focus before click fires.
                          e.preventDefault();
                        }}
                        onClick={() => commit(idx)}
                      >
                        <span
                          className="voice-selector__flag"
                          aria-hidden="true"
                        >
                          {flag(v.language)}
                        </span>
                        <span className="voice-selector__option-name">
                          {v.name}
                        </span>
                        <span
                          className="voice-selector__option-meta"
                          aria-hidden="true"
                        >
                          ({genderLetter(v.gender)} &middot; {v.quality})
                        </span>
                        {isSelected ? (
                          <CheckIcon />
                        ) : (
                          <span
                            className="voice-selector__check-spacer"
                            aria-hidden="true"
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
