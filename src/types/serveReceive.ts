/**
 * serveReceive.ts — result types for the serve-receive (passing) technique.
 *
 * Deliberately different in shape from types/spike.ts, in one important way:
 * **nothing here carries a Rating**. The spike ships with coaching thresholds
 * from the design brief (115–145° danger, 130–133° optimal), so it can colour a
 * card red or green and mean it. Passing has no such numbers behind it yet, and
 * inventing bands would dress a guess up as coaching advice. So this technique
 * measures and reports: a value, a unit, and what was measured. The coach
 * supplies the judgement until real thresholds exist.
 *
 * `warnings` (on BaseAnalysis) still apply — those are not verdicts on
 * technique, they say whether the measurement can be trusted at all.
 *
 * On units. Angles are degrees. Distances and speeds come from MediaPipe's
 * metric world landmarks, so they are metres and m/s — but that scale is
 * normalised to an average adult body, not measured, so treat the magnitudes
 * as approximate. Comparing the same athlete across clips is the sound use;
 * comparing two athletes' absolute centimetres is not.
 */

import type { BaseAnalysis } from "./technique";

/** One measured number, with no verdict attached. See the file header. */
export interface Reading {
  label: string;
  /** Null when the landmarks it needs were not tracked. Renders as "—". */
  value: number | null;
  /** "°", "m", "m/s", "°/s", "cm". Rendered next to the value. */
  unit: string;
  /**
   * What this number is and how it was taken — never whether it is good.
   * Keep it factual: "Angle between the forearms and the horizontal at the
   * contact frame", not "should be around 45°".
   */
  detail: string;
}

/** A scorecard card: a few related readings under one heading. */
export interface ReadingGroup {
  title: string;
  readings: Reading[];
}

/**
 * How the contact frame was arrived at.
 *
 * A spike hands us contact for free — the wrist decelerates hard at impact, so
 * peak wrist speed lands within a frame of it. A pass gives no such signal:
 * MediaPipe never sees the ball, and a good platform is nearly motionless at
 * contact. Every number in this result is defined at or around that frame, so
 * being wrong about it is being wrong about everything at once — which is why
 * the coach can override it, and why the result records which it was.
 */
export type ContactSource = "detected" | "manual" | "none";

/**
 * Per-frame traces the charts draw. Every array is one entry per frame, null
 * where the landmarks behind it were not confidently tracked.
 */
export interface ServeReceiveSeries {
  /** Platform inclination: forearm line vs the horizontal, degrees. */
  platformInclination: (number | null)[];
  /** Lateral platform tilt, from the shoulder line vs horizontal, degrees. */
  shoulderTilt: (number | null)[];
  /** Elbow angle, the straighter-armed side taken per frame. 180° = straight. */
  elbow: (number | null)[];
  /** Knee angle, degrees. 180° = straight leg. */
  knee: (number | null)[];
  /** Trunk-to-thigh angle (the hip hinge), degrees. */
  hipTrunk: (number | null)[];
  /** Upper arm to trunk, degrees. */
  armTrunk: (number | null)[];
  /** Ankle angle (shank to foot), degrees. Lowest-confidence trace — feet are
   *  small, often occluded, and the first thing the model loses. */
  ankle: (number | null)[];
  /** Ankle speed, m/s — the "are the feet grounded at contact" trace. */
  footSpeed: (number | null)[];
  /** Hip-midpoint vertical speed, m/s. Positive is rising (leg drive). */
  hipRiseSpeed: (number | null)[];
  /** How fast the platform is rotating, °/s — the swing-vs-push trace. */
  platformAngularSpeed: (number | null)[];
}

export interface ServeReceiveAnalysis extends BaseAnalysis {
  technique: "serve-receive";
  /** Ball contact on the platform. Mirrored into BaseAnalysis.keyFrame. */
  contactFrame: number | null;
  contactSource: ContactSource;
  series: ServeReceiveSeries;
  /** What the scorecard renders, in card order. */
  groups: ReadingGroup[];
}
