interface Props {
  duration: number;
  start: number;
  end: number;
  onChange: (range: { start: number; end: number }) => void;
  /** Called while dragging so the video can preview the frame being set. */
  onScrub?: (seconds: number) => void;
}

/**
 * Two-handle trim control. Kept as native range inputs so the tablet's own
 * touch handling drives it — that is what makes scrubbing feel smooth without
 * any pointer-event bookkeeping of our own.
 */
export default function TrimSlider({ duration, start, end, onChange, onScrub }: Props) {
  const step = 1 / 120;
  const clampStart = (value: number) => Math.min(value, end - step);
  const clampEnd = (value: number) => Math.max(value, start + step);

  return (
    <div className="panel">
      <div className="mb-1 flex items-baseline justify-between text-sm text-slate-400">
        <span>Trim to the jump and swing</span>
        <span className="font-mono tabular-nums text-signal-accent">
          {(end - start).toFixed(2)}s
        </span>
      </div>

      <label className="block">
        <span className="sr-only">Clip start</span>
        <input
          type="range"
          className="scrub"
          min={0}
          max={duration}
          step={step}
          value={start}
          onChange={(event) => {
            const value = clampStart(Number(event.target.value));
            onChange({ start: value, end });
            onScrub?.(value);
          }}
        />
      </label>

      <label className="block">
        <span className="sr-only">Clip end</span>
        <input
          type="range"
          className="scrub"
          min={0}
          max={duration}
          step={step}
          value={end}
          onChange={(event) => {
            const value = clampEnd(Number(event.target.value));
            onChange({ start, end: value });
            onScrub?.(value);
          }}
        />
      </label>

      <div className="flex justify-between font-mono text-xs tabular-nums text-slate-500">
        <span>{start.toFixed(2)}s</span>
        <span>{end.toFixed(2)}s</span>
      </div>
    </div>
  );
}
