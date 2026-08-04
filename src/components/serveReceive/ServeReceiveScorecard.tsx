import type { ScorecardProps } from "../../types/technique";
import type { Reading, ServeReceiveAnalysis } from "../../types/serveReceive";

/**
 * Decimal places by unit.
 *
 * Precision is a claim, so these are capped at what the measurement can
 * actually support. Metre-scale quantities work well under 10 and get two
 * digits (1 cm resolution); degrees get one, as on the spike scorecard. But
 * centimetres and °/s get none: MediaPipe's world scale is normalised to an
 * average adult rather than measured (see types/serveReceive.ts), so "7 cm"
 * is honest where "6.83 cm" would be inventing two digits the model never had.
 */
const DECIMALS_BY_UNIT: Record<string, number> = { m: 2, "m/s": 2, cm: 0, "°/s": 0 };

function formatValue(value: number, unit: string): string {
  return value.toFixed(DECIMALS_BY_UNIT[unit] ?? 1);
}

/**
 * One measured number: label, value+unit, and the factual detail line
 * beneath it. Deliberately no badge, no colour, no icon — Reading has no
 * rating field, and colouring by magnitude would smuggle a threshold in
 * through the back door. See types/serveReceive.ts's file header.
 */
function ReadingRow({ label, value, unit, detail }: Reading) {
  return (
    <div className="border-t border-court-line/60 pt-2 first:border-t-0 first:pt-0 split:pt-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-slate-400 split:text-xs">{label}</span>
        <span className="whitespace-nowrap tabular-nums text-lg font-bold text-slate-100 split:text-base">
          {value == null ? "—" : formatValue(value, unit)}
          {value != null && <span className="ml-0.5 text-xs font-normal text-slate-400">{unit}</span>}
        </span>
      </div>
      <p className="mt-0.5 text-xs leading-snug text-slate-500 split:hidden">{detail}</p>
    </div>
  );
}

/** One scorecard card: a group's title plus its readings, stacked. */
function Card({ title, readings }: { title: string; readings: Reading[] }) {
  return (
    <div className="rounded-2xl border border-court-line bg-court-panel/60 p-4 split:p-2.5 flex min-w-0 flex-col gap-2 split:gap-1">
      <h4 className="truncate text-sm uppercase tracking-wide text-slate-400 split:text-[10px]">{title}</h4>
      {readings.length === 0 ? (
        <p className="text-sm text-slate-500 split:text-xs">No readings.</p>
      ) : (
        <div className="flex flex-col gap-2 split:gap-1">
          {readings.map((reading) => (
            <ReadingRow key={reading.label} {...reading} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ServeReceiveScorecard({ analysis }: ScorecardProps<ServeReceiveAnalysis>) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {analysis.groups.map((group) => (
        <Card key={group.title} title={group.title} readings={group.readings} />
      ))}
    </div>
  );
}
