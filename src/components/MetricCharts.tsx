import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ABDUCTION_DANGER_HIGH,
  ABDUCTION_DANGER_LOW,
  ABDUCTION_OPTIMAL_HIGH,
  ABDUCTION_OPTIMAL_LOW,
} from "../lib/biomechanics";
import type { AnalysisResult } from "../types/pose";

interface Props {
  analysis: AnalysisResult;
  frameIndex: number;
  onSeekFrame: (frame: number) => void;
}

const JOINT_COLORS: Record<string, string> = {
  hip: "#f472b6",
  shoulder: "#facc15",
  elbow: "#4ade80",
  wrist: "#22d3ee",
};

const AXIS = { stroke: "#64748b", fontSize: 11 } as const;

const TOOLTIP_STYLE = {
  backgroundColor: "#0f172a",
  border: "1px solid #1e293b",
  borderRadius: 12,
  fontSize: 12,
} as const;

/**
 * Velocity and angle traces, sharing a play-head with the video.
 *
 * Charts render to canvas-friendly SVG through Recharts; series are memoised
 * because a 5 s clip at 60 fps is ~300 points per joint and the play-head
 * updates on every animation frame while the video plays.
 */
export default function MetricCharts({ analysis, frameIndex, onSeekFrame }: Props) {
  const velocityData = useMemo(() => {
    const length = analysis.kineticChain.series[0]?.speed.length ?? 0;
    return Array.from({ length }, (_, frame) => {
      const row: Record<string, number | null> = { frame };
      for (const series of analysis.kineticChain.series) {
        row[series.joint] = series.speed[frame] ?? null;
      }
      return row;
    });
  }, [analysis]);

  const angleData = useMemo(
    () =>
      analysis.abductionSeries.map((abduction, frame) => ({
        frame,
        abduction,
        elbow: analysis.elbowSeries[frame] ?? null,
      })),
    [analysis],
  );

  const handleClick = (state: { activeLabel?: string | number }) => {
    const frame = Number(state?.activeLabel);
    if (Number.isFinite(frame)) onSeekFrame(frame);
  };

  const { contactFrame, elbowTiming } = analysis;

  return (
    <div className="flex flex-col gap-3">
      <section className="panel" data-testid="chart-joint-speed">
        <header className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Kinetic chain — joint speed</h3>
          <div className="flex gap-3 text-xs">
            {analysis.kineticChain.series.map((series) => (
              <span key={series.joint} className="flex items-center gap-1">
                <span
                  className="inline-block h-2 w-4 rounded"
                  style={{ backgroundColor: JOINT_COLORS[series.joint] }}
                />
                {series.joint}
              </span>
            ))}
          </div>
        </header>

        <ResponsiveContainer width="100%" height={190}>
          <LineChart data={velocityData} onClick={handleClick}>
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis dataKey="frame" {...AXIS} />
            <YAxis
              {...AXIS}
              width={38}
              label={{
                value: "torso/s",
                angle: -90,
                position: "insideLeft",
                fill: "#64748b",
                fontSize: 10,
              }}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number | string) =>
                typeof value === "number" ? value.toFixed(1) : value
              }
            />

            {analysis.kineticChain.series.map((series) => (
              <Line
                key={series.joint}
                type="monotone"
                dataKey={series.joint}
                stroke={JOINT_COLORS[series.joint]}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))}

            {/* Peak markers make the firing order readable at a glance. */}
            {analysis.kineticChain.series.map((series) =>
              series.peakFrame >= 0 ? (
                <ReferenceLine
                  key={`peak-${series.joint}`}
                  x={series.peakFrame}
                  stroke={JOINT_COLORS[series.joint]}
                  strokeDasharray="2 4"
                  strokeOpacity={0.7}
                />
              ) : null,
            )}

            <ReferenceLine x={frameIndex} stroke="#e2e8f0" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <section className="panel" data-testid="chart-angles">
        <header className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Shoulder abduction &amp; elbow angle</h3>
          <span className="text-xs text-slate-400">degrees</span>
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

            {/* The elite abduction window, drawn as a target band. */}
            <ReferenceArea
              y1={ABDUCTION_OPTIMAL_LOW}
              y2={ABDUCTION_OPTIMAL_HIGH}
              fill="#22c55e"
              fillOpacity={0.18}
            />
            <ReferenceLine y={ABDUCTION_DANGER_LOW} stroke="#ef4444" strokeOpacity={0.5} />
            <ReferenceLine y={ABDUCTION_DANGER_HIGH} stroke="#ef4444" strokeOpacity={0.5} />

            <Line
              type="monotone"
              dataKey="abduction"
              name="Abduction"
              stroke="#22d3ee"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="elbow"
              name="Elbow"
              stroke="#4ade80"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls
            />

            {elbowTiming.cockingEndFrame != null && (
              <ReferenceLine
                x={elbowTiming.cockingEndFrame}
                stroke="#facc15"
                strokeDasharray="4 4"
                label={{ value: "cock", fill: "#facc15", fontSize: 10 }}
              />
            )}
            {contactFrame != null && (
              <ReferenceLine
                x={contactFrame}
                stroke="#f59e0b"
                strokeDasharray="4 4"
                label={{ value: "contact", fill: "#f59e0b", fontSize: 10 }}
              />
            )}

            <ReferenceLine x={frameIndex} stroke="#e2e8f0" strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </section>
    </div>
  );
}
