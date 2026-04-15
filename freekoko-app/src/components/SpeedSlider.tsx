interface Props {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}

const MIN = 0.5;
const MAX = 2.0;
const STEP = 0.1;

function clamp(n: number): number {
  if (Number.isNaN(n)) return 1.0;
  return Math.min(MAX, Math.max(MIN, Math.round(n * 10) / 10));
}

export function SpeedSlider({ value, onChange, disabled }: Props) {
  const v = clamp(value);
  return (
    <div className="speed-slider">
      <label className="speed-label">
        Speed <span className="speed-value">{v.toFixed(1)}x</span>
      </label>
      <div className="speed-row">
        <input
          type="range"
          min={MIN}
          max={MAX}
          step={STEP}
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          aria-label="Playback speed"
        />
        <button
          type="button"
          className="speed-reset"
          onClick={() => onChange(1.0)}
          disabled={disabled || v === 1.0}
          title="Reset to 1.0x"
          aria-label="Reset speed to 1.0x"
        >
          <svg
            viewBox="0 0 12 12"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            focusable="false"
          >
            <path d="M10 6a4 4 0 1 1-1.3-2.96" />
            <path d="M10 2v2.5H7.5" />
          </svg>
        </button>
      </div>
      <div className="speed-scale">
        <span>{MIN.toFixed(1)}x</span>
        <span>{MAX.toFixed(1)}x</span>
      </div>
    </div>
  );
}
