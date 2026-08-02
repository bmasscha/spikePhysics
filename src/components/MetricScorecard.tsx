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
    <div className={`rounded-2xl border ${style.ring} bg-court-panel/60 p-4`}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h4 className="text-sm uppercase tracking-wide text-slate-400">{title}</h4>
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${style.badge}`}>
          {style.icon} {rating}
        </span>
      </div>
      <p className="text-2xl font-bold text-slate-100">{headline}</p>
      <p className="mt-1 text-sm leading-snug text-slate-400">{detail}</p>
    </div>
  );
}

export default function MetricScorecard({ analysis }: { analysis: AnalysisResult }) {
  const { abductionAtContact, kineticChain, elbowTiming } = analysis;

  return (
    <div className="flex flex-col gap-3">
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
          className="rounded-2xl border border-signal-warn/30 bg-signal-warn/10 p-3 text-sm text-signal-warn"
        >
          {warning}
        </p>
      ))}
    </div>
  );
}
