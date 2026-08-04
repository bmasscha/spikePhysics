/**
 * serveReceive.ts — placeholder registration for serve-receive (passing).
 *
 * Not implemented yet: no result type, no biomechanics, no dashboard
 * components. This entry exists purely so the technique picker can list the
 * card and so the id is reserved in TechniqueId ahead of the real
 * implementation — see types/technique.ts for why "coming soon" techniques
 * are a separate, smaller shape than a ready one.
 */

import type { UpcomingTechnique } from "../../types/technique";

export const serveReceiveTechnique: UpcomingTechnique = {
  id: "serve-receive",
  status: "coming-soon",
  name: "Serve-receive",
  icon: "🛡️",
  blurb: "Passing platform — angle, posture and stability under a served ball.",
  measures: [
    "Platform angle at contact",
    "Posture/trunk lean through the pass",
    "Base stability (weight transfer, foot placement)",
  ],
  captureHint:
    "Film face-on to the passer, camera perpendicular to the direction of the pass, whole body in frame from ready position through the pass.",
  maxRecordingSeconds: 5,
  maxAnalysisSeconds: 10,
  note: "Coming soon",
};
