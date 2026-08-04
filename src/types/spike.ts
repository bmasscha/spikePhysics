/**
 * spike.ts — result types for the spike technique.
 *
 * These used to live in types/pose.ts, back when a spike was the only thing the
 * app could analyse. They moved here when the technique registry landed: pose.ts
 * now holds what every technique shares, and each technique owns its own result
 * shape next to it (serve-receive will get types/serveReceive.ts).
 */

import type { Metric, Rating } from "./pose";
import type { BaseAnalysis } from "./technique";

export interface JointSeries {
  joint: "hip" | "shoulder" | "elbow" | "wrist";
  /** Speed per frame in torso-lengths/second; null where landmarks were lost. */
  speed: (number | null)[];
  /** Frame index of peak speed, or -1. */
  peakFrame: number;
  peakSpeed: number | null;
}

export interface KineticChainResult {
  series: JointSeries[];
  /** True when peaks fire hip → shoulder → elbow → wrist in order. */
  isSequenced: boolean;
  /** Frame indices in the order the joints actually peaked. */
  observedOrder: JointSeries["joint"][];
  message: string;
  rating: Rating;
}

export interface ElbowTimingResult {
  cockingEndFrame: number | null;
  contactFrame: number | null;
  extensionOnsetFrame: number | null;
  /** Onset expressed as a fraction of the swing duration, [0,1]. */
  onsetRatio: number | null;
  rating: Rating;
  label: string;
  detail: string;
}

export interface SpikeAnalysis extends BaseAnalysis {
  technique: "spike";
  /** Frame of ball contact. Mirrored into BaseAnalysis.keyFrame. */
  contactFrame: number | null;
  /** Torso-lengths per pixel, per frame. Null where the torso wasn't visible. */
  scaleFactors: (number | null)[];
  /** Shoulder abduction angle per frame, in degrees. */
  abductionSeries: (number | null)[];
  /** Elbow flexion angle per frame, in degrees (180 = fully extended). */
  elbowSeries: (number | null)[];
  abductionAtContact: Metric;
  kineticChain: KineticChainResult;
  elbowTiming: ElbowTimingResult;
}
