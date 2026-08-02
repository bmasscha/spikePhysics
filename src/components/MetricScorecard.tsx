import type { AnalysisResult, Rating } from "../types/pose";

const RATING_STYLE: Record<Rating, { badge: string; ring: string; icon: string }> = {
  optimal: { badge: "bg-signal-ok/15 text-signal-ok", ring: "border-signal-ok/40", icon: "🟢" },
  acceptable: { badge: "bg-signal-warn/15 text-signal-warn", ring: "border-signal-warn/40", icon: "🟡" },
  danger: { badge: "bg-signal-danger/15 text-signal-danger", ring: "border-signal-danger/40", icon: "🔴" },
  unknown: { badge: "bg-slate-700/40 text-slate-300", ring: "border-court-line", icon: "⚪" },
};

function Card({
  title,
  headline,
  detail,
  rating,
}: {
  title: string;
  headline: string;
  detail: string;
  rating: Rating;
}) {
  const style = RATING_STYLE[rating];
  return (
    <div className={`rounded-2xl border ${style.ring} bg-court-panel/60 p-4 split:p-2.5 flex flex-col justify-between min-w-0`}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-sm uppercase tracking-wide text-slate-400 truncate split:text-[10px]">{title}</h4>
        <span className={`rounded-full px-3 py-1 text-xs font-bold split:px-1.5 split:py-0.5 split:text-[10px] ${style.badge}`}>
          {style.icon} <span className="split:hidden">{rating}</span>
        </span>
      </div>
      <p className="text-2xl font-bold text-slate-100 split:text-lg">{headline}</p>
      <p className="mt-1 text-sm leading-snug text-slate-400 split:hidden">{detail}</p>
    </div>
  );
}

export default function MetricScorecard({ analysis }: { analysis: AnalysisResult }) {
  const { abductionAtContact, kineticChain, elbowTiming } = analysis;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Card
        title="Shoulder abduction at contact"
        headline={
          abductionAtContact.value == null ? "—" : `${abductionAtContact.value.toFixed(1)}°`
        }
        detail={abductionAtContact.detail}
        rating={abductionAtContact.rating}
      />

      <Card
        title="Kinetic chain"
        headline={
          kineticChain.observedOrder.length > 0
            ? kineticChain.observedOrder.join(" → ")
            : "not measurable"
        }
        detail={kineticChain.message}
        rating={kineticChain.rating}
      />

      <Card
        title="Elbow extension timing"
        headline={
          elbowTiming.onsetRatio == null
            ? "—"
            : `${Math.round(elbowTiming.onsetRatio * 100)}% of swing`
        }
        detail={`${elbowTiming.label}. ${elbowTiming.detail}`}
        rating={elbowTiming.rating}
      />

      {analysis.warnings.map((warning) => (
        <p
          key={warning}
          className="rounded-2xl border border-signal-warn/30 bg-signal-warn/10 p-3 text-sm text-signal-warn sm:col-span-3"
        >
          {warning}
        </p>
      ))}
    </div>
  );
}
