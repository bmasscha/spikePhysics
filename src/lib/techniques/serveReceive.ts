/**
 * serveReceive.ts — the serve-receive (passing) technique definition.
 *
 * Wires the passing biomechanics (passing.ts), mock generator (mockPass.ts)
 * and dashboard components (components/serveReceive/*) behind the
 * TechniqueDefinition contract, exactly as spike.ts does for the spike. All
 * the maths lives in those modules; this file only describes them to the
 * registry.
 */

import { analyzePass } from "../passing";
import { generateMockPass } from "../mockPass";
import { smoothSequence } from "../smoothing";
import { defineTechnique } from "../../types/technique";
import type { KeyMoment } from "../../types/technique";
import type { ServeReceiveAnalysis } from "../../types/serveReceive";
import ServeReceiveScorecard from "../../components/serveReceive/ServeReceiveScorecard";
import ServeReceiveCharts from "../../components/serveReceive/ServeReceiveCharts";

export const serveReceiveTechnique = defineTechnique<ServeReceiveAnalysis>({
  id: "serve-receive",
  status: "ready",
  name: "Serve-receive",
  icon: "🛡️",
  blurb: "Passing platform — angle, posture and stability under a served ball.",
  measures: [
    "Platform angle at contact",
    "Posture/trunk lean through the pass",
    "Base stability (weight transfer, foot placement)",
  ],
  // Unlike the spike, this is filmed at ~45° rather than side-on: every
  // measurement here is taken in the player's own body frame (see
  // bodyFrame.ts), so the camera angle is free — but the whole body, feet
  // included, has to stay in frame, since the ankle trace and the leg-drive
  // proxy both depend on the ankles being tracked.
  captureHint:
    "Film the passer from roughly 45°, whole body in frame including the feet, from the ready position through the pass.",
  maxRecordingSeconds: 5,
  maxAnalysisSeconds: 10,
  analyze: (sequence, options) => analyzePass(sequence, options),
  // The spike detects contact from peak wrist speed and is right; a pass has
  // no such signal (MediaPipe never sees the ball, and a good platform is
  // nearly still at contact), so the coach gets the last word — see
  // AnalyzeOptions.keyFrame and ContactSource.
  keyFrameLabel: "contact",
  generateMock: () => smoothSequence(generateMockPass()),
  keyMoments: (analysis): KeyMoment[] => [{ label: "Contact", frame: analysis.contactFrame }],
  Scorecard: ServeReceiveScorecard,
  Charts: ServeReceiveCharts,
});
