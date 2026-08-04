import { TECHNIQUES, isReady } from "../lib/techniques";
import type { AnyTechnique, TechniqueEntry } from "../types/technique";

interface Props {
  onSelect: (technique: AnyTechnique) => void;
}

/**
 * The app's first stage: "what are we analysing?" One card per registered
 * technique (see lib/techniques/index.ts). A ready technique is a real,
 * tappable card; a technique still on the roadmap is shown in the same grid,
 * so a coach can see what is coming, but is visually flattened and inert —
 * disabled rather than hidden, because "coming soon" is itself useful
 * information on a tablet a coach might hand to someone else.
 */
export default function TechniquePicker({ onSelect }: Props) {
  return (
    // No p-safe here: <main>'s ancestor already applies it, and nesting the
    // safe-area padding double-insets the grid on a notched tablet.
    <div className="flex h-full flex-col gap-6 overflow-y-auto">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-slate-100 split:text-3xl">
          What are we analysing?
        </h1>
        <p className="text-sm text-slate-400 split:text-base">
          Pick a technique to film or import a clip for.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 split:grid-cols-3">
        {TECHNIQUES.map((entry) => (
          <TechniqueCard key={entry.id} entry={entry} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function TechniqueCard({
  entry,
  onSelect,
}: {
  entry: TechniqueEntry;
  onSelect: (technique: AnyTechnique) => void;
}) {
  const ready = isReady(entry);

  // A coming-soon card renders the same content as a ready one but as a
  // disabled <button> rather than a link-like element with an onClick — a
  // screen reader announces it as unavailable, and there is no click handler
  // to accidentally wire up later and make it silently selectable.
  return (
    <button
      type="button"
      className={
        ready
          ? "panel flex min-h-[220px] flex-col gap-3 border-court-line text-left transition-colors active:bg-slate-800 split:min-h-[180px]"
          : "panel flex min-h-[220px] flex-col gap-3 border-court-line text-left opacity-40 split:min-h-[180px]"
      }
      disabled={!ready}
      aria-disabled={!ready}
      onClick={ready ? () => onSelect(entry) : undefined}
    >
      <div className="flex items-center gap-3">
        <span className="text-3xl" aria-hidden="true">
          {entry.icon}
        </span>
        <div>
          <h2 className="text-lg font-semibold text-slate-100">{entry.name}</h2>
          <p className="text-sm text-slate-400">{entry.blurb}</p>
        </div>
      </div>

      <ul className="flex flex-1 flex-col gap-1 text-sm text-slate-300">
        {entry.measures.map((measure) => (
          <li key={measure} className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-accent" aria-hidden="true" />
            {measure}
          </li>
        ))}
      </ul>

      {ready ? (
        <span className="btn-primary min-h-tap justify-center">Analyse a {entry.name.toLowerCase()}</span>
      ) : (
        <span className="inline-flex min-h-tap items-center justify-center rounded-2xl border border-court-line bg-court-panel px-5 text-sm font-semibold text-slate-400">
          {entry.note}
        </span>
      )}
    </button>
  );
}
