import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartsProps } from "../../types/technique";
import type { ServeReceiveAnalysis } from "../../types/serveReceive";

const AXIS = { stroke: "#64748b", fontSize: 11 } as const;

const TOOLTIP_STYLE = {
  backgroundColor: "#0f172a",
  border: "1px solid #1e293b",
  borderRadius: 12,
  fontSize: 12,
} as const;

const CONTACT_STROKE = "#f59e0b";
const PLAYHEAD_STROKE = "#e2e8f0";

/**
 * Panel 1 traces. `ankle` is drawn thinner, dashed and dimmer than the rest —
 * its doc comment in types/serveReceive.ts flags it as the lowest-confidence
 * trace (feet are small and easily occluded), so the chart should not let it
 * compete visually with the others.
 */
interface AngleTrace {
  key: "platformInclination" | "elbow" | "knee" | "hipTrunk" | "ankle";
  label: string;
  color: string;
  muted?: boolean;
}

const ANGLE_TRACES: readonly AngleTrace[] = [
  { key: "platformInclination", label: "Platform", color: "#22d3ee" },
  { key: "elbow", label: "Elbow", color: "#4ade80" },
  { key: "knee", label: "Knee", color: "#facc15" },
  { key: "hipTrunk", label: "Hip-trunk", color: "#f472b6" },
  { key: "ankle", label: "Ankle", color: "#64748b", muted: true },
];

/** Panel 2 traces. footSpeed/hipRiseSpeed share the left (m/s) axis; platform
 *  angular speed gets its own right axis since °/s is a different unit. */
const STABILITY_TRACES = [
  { key: "footSpeed", label: "Foot speed", color: "#22d3ee", axis: "speed", unit: "m/s" },
  { key: "hipRiseSpeed", label: "Hip rise", color: "#4ade80", axis: "speed", unit: "m/s" },
  { key: "platformAngularSpeed", label: "Platform ang. speed", color: "#f59e0b", axis: "angular", unit: "°/s" },
] as const;

const STABILITY_UNIT_BY_LABEL: Record<string, string> = Object.fromEntries(
  STABILITY_TRACES.map((trace) => [trace.label, trace.unit]),
);

function Legend({ traces }: { traces: readonly { key: string; label: string; color: string; muted?: boolean }[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-xs">
      {traces.map((trace) => (
        <span key={trace.key} className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-4 rounded"
            style={{ backgroundColor: trace.color, opacity: trace.muted ? 0.6 : 1 }}
          />
          {trace.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Angle and speed traces for a pass, sharing a play-head with the video.
 *
 * Mirrors SpikeCharts: series are memoised because a 5 s clip at 60 fps is
 * ~300 points per trace and the play-head updates every animation frame
 * while the video plays. Unlike the spike's charts there are no optimal
 * bands or danger lines here — passing has no coaching thresholds yet, see
 * types/serveReceive.ts's file header.
 */
export default function ServeReceiveCharts({ analysis, frameIndex, onSeekFrame }: ChartsProps<ServeReceiveAnalysis>) {
  const { series, contactFrame } = analysis;

  const angleData = useMemo(() => {
    const length = series.platformInclination.length;
    return Array.from({ length }, (_, frame) => ({
      frame,
      platformInclination: series.platformInclination[frame] ?? null,
      elbow: series.elbow[frame] ?? null,
      knee: series.knee[frame] ?? null,
      hipTrunk: series.hipTrunk[frame] ?? null,
      ankle: series.ankle[frame] ?? null,
    }));
  }, [series]);

  const stabilityData = useMemo(() => {
    const length = series.footSpeed.length;
    return Array.from({ length }, (_, frame) => ({
      frame,
      footSpeed: series.footSpeed[frame] ?? null,
      hipRiseSpeed: series.hipRiseSpeed[frame] ?? null,
      platformAngularSpeed: series.platformAngularSpeed[frame] ?? null,
    }));
  }, [series]);

  const handleClick = (state: { activeLabel?: string | number }) => {
    const frame = Number(state?.activeLabel);
    if (Number.isFinite(frame)) onSeekFrame(frame);
  };

  return (
    <div className="flex flex-col gap-3">
      <section className="panel" data-testid="chart-pass-angles">
        <header className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Angles through the pass</h3>
          <Legend traces={ANGLE_TRACES} />
        </header>

        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={angleData} onClick={handleClick}>
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis dataKey="frame" {...AXIS} />
            <YAxis {...AXIS} width={38} domain={[0, 180]} ticks={[0, 45, 90, 135, 180]} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number | string) =>
                typeof value === "number" ? `${value.toFixed(0)}°` : value
              }
            />

            {ANGLE_TRACES.map((trace) => (
              <Line
                key={trace.key}
                type="monotone"
                dataKey={trace.key}
                name={trace.label}
                stroke={trace.color}
                strokeWidth={trace.muted ? 1 : 2}
                strokeOpacity={trace.muted ? 0.6 : 1}
                strokeDasharray={trace.muted ? "3 3" : undefined}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}

            {contactFrame != null && (
              <ReferenceLine
                x={contactFrame}
                stroke={CONTACT_STROKE}
                strokeDasharray="4 4"
                label={{ value: "contact", fill: CONTACT_STROKE, fontSize: 10 }}
              />
            )}

            <ReferenceLine x={frameIndex} stroke={PLAYHEAD_STROKE} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section className="panel" data-testid="chart-pass-stability">
        <header className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Stability and drive</h3>
          <Legend traces={STABILITY_TRACES} />
        </header>

        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={stabilityData} onClick={handleClick}>
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis dataKey="frame" {...AXIS} />
            <YAxis
              yAxisId="speed"
              orientation="left"
              {...AXIS}
              width={38}
              label={{ value: "m/s", angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 10 }}
            />
            <YAxis
              yAxisId="angular"
              orientation="right"
              {...AXIS}
              width={42}
              label={{ value: "°/s", angle: 90, position: "insideRight", fill: "#64748b", fontSize: 10 }}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number | string, name: string) =>
                typeof value === "number"
                  ? `${value.toFixed(1)} ${STABILITY_UNIT_BY_LABEL[name] ?? ""}`.trim()
                  : value
              }
            />

            {STABILITY_TRACES.map((trace) => (
              <Line
                key={trace.key}
                yAxisId={trace.axis === "speed" ? "speed" : "angular"}
                type="monotone"
                dataKey={trace.key}
                name={trace.label}
                stroke={trace.color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}

            {contactFrame != null && (
              <ReferenceLine
                x={contactFrame}
                yAxisId="speed"
                stroke={CONTACT_STROKE}
                strokeDasharray="4 4"
                label={{ value: "contact", fill: CONTACT_STROKE, fontSize: 10 }}
              />
            )}

            <ReferenceLine x={frameIndex} yAxisId="speed" stroke={PLAYHEAD_STROKE} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </section>
    </div>
  );
}
