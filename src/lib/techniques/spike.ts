/**
 * spike.ts — the spike technique definition.
 *
 * Wires the existing spike biomechanics (biomechanics.ts), mock generator
 * (mockData.ts) and dashboard components (components/spike/*) behind the
 * TechniqueDefinition contract. This is the technique the app shipped with
 * before the picker existed, so nothing about the maths or thresholds changes
 * here — this file only describes it to the registry.
 */

import { analyzeSequence } from "../biomechanics";
import { generateMockSequence } from "../mockData";
import { smoothSequence } from "../smoothing";
import { defineTechnique } from "../../types/technique";
import type { KeyMoment } from "../../types/technique";
import type { SpikeAnalysis } from "../../types/spike";
import SpikeScorecard from "../../components/spike/SpikeScorecard";
import SpikeCharts from "../../components/spike/SpikeCharts";

export const spikeTechnique = defineTechnique<SpikeAnalysis>({
  id: "spike",
  status: "ready",
  name: "Spike",
  icon: "🏐",
  blurb: "Attack swing — shoulder safety and how the whole chain fires.",
  measures: [
    "Shoulder abduction at contact",
    "Kinetic chain sequencing",
    "Elbow extension timing (whip vs push)",
  ],
  captureHint:
    "Film from the sideline, camera perpendicular to the player, whole body in frame, from the approach through just after the hit.",
  // 5 s keeps the inference pass under a few seconds — was CameraModule's
  // MAX_RECORDING_MS.
  maxRecordingSeconds: 5,
  // An imported clip can be minutes long; at ~30 samples/s that is thousands
  // of MediaPipe inferences and a locked-up tablet, so only the first window
  // of this length is ever processed — was App.tsx's MAX_ANALYSIS_SECONDS.
  maxAnalysisSeconds: 10,
  analyze: (sequence) => analyzeSequence(sequence),
  // App.tsx smoothed the mock sequence before analysing it; that step belongs
  // to the technique now, not the shell.
  generateMock: () => smoothSequence(generateMockSequence()),
  keyMoments: (analysis): KeyMoment[] => [
    { label: "Cocking end", frame: analysis.elbowTiming.cockingEndFrame },
    { label: "Contact", frame: analysis.contactFrame },
  ],
  Scorecard: SpikeScorecard,
  Charts: SpikeCharts,
});
