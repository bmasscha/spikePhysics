/**
 * biomechanics.ts — the four analyses from §4 of the design brief.
 *
 *   A. Dynamic scale-factor calibration (torso metric)
 *   B. 3D shoulder abduction angle
 *   C. Kinetic-chain sequencing
 *   D. Elbow extension timing (stretch-shortening cycle)
 *
 * All geometry goes through vectorMath; this file owns the *anatomical*
 * interpretation and the coaching thresholds.
 */

import {
  angleAt,
  argMax,
  argMin,
  derivative,
  distance,
  midpoint,
  speedBetween,
} from "./vectorMath";
import {
  CORE_LANDMARKS,
  detectHittingSide,
  getLandmark,
  indicesFor,
  LM,
  pixelPoint,
  spatialPoint,
} from "./landmarks";
import type { ElbowTimingResult, JointSeries, KineticChainResult, SpikeAnalysis } from "../types/spike";
import type { HittingSide, Metric, PoseFrame, PoseSequence, Rating } from "../types/pose";

// ---------------------------------------------------------------------------
// Coaching thresholds (§4B and §4D)
// ---------------------------------------------------------------------------

export const ABDUCTION_DANGER_LOW = 115;
export const ABDUCTION_DANGER_HIGH = 145;
export const ABDUCTION_OPTIMAL_LOW = 130;
export const ABDUCTION_OPTIMAL_HIGH = 133;

export const WHIP_ONSET_RATIO = 0.55;
export const PUSH_ONSET_RATIO = 0.75;

// ---------------------------------------------------------------------------
// A. Dynamic scale factor calibration
// ---------------------------------------------------------------------------

/**
 * Torso length in pixels: shoulder midpoint to hip midpoint.
 * @returns null when any of the four trunk landmarks is not confidently tracked.
 */
export function torsoLengthPixels(frame: PoseFrame | undefined): number | null {
  const [leftShoulder, rightShoulder, leftHip, rightHip] = CORE_LANDMARKS.map((i) =>
    getLandmark(frame, i),
  );
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return null;

  const shoulderMid = midpoint(pixelPoint(leftShoulder), pixelPoint(rightShoulder));
  const hipMid = midpoint(pixelPoint(leftHip), pixelPoint(rightHip));
  const length = distance(shoulderMid, hipMid);
  return length > 0 ? length : null;
}

/**
 * Scale factor in torso-lengths per pixel, recomputed per frame so that a player
 * moving toward or away from the camera does not distort measured velocities.
 */
export function calculateScaleFactor(frame: PoseFrame | undefined): number | null {
  const torsoPixels = torsoLengthPixels(frame);
  return torsoPixels == null ? null : 1 / torsoPixels;
}

export function scaleFactorSeries(frames: readonly PoseFrame[]): (number | null)[] {
  return frames.map((frame) => calculateScaleFactor(frame));
}

/** Median of the finite entries, used to fill frames where the trunk was lost. */
export function medianOf(values: readonly (number | null)[]): number | null {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length === 0) return null;
  finite.sort((a, b) => a - b);
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1]! + finite[mid]!) / 2 : finite[mid]!;
}

/** Per-frame scale with gaps filled from the clip median. */
function resolvedScales(frames: readonly PoseFrame[]): (number | null)[] {
  const raw = scaleFactorSeries(frames);
  const fallback = medianOf(raw);
  return raw.map((s) => s ?? fallback);
}

// ---------------------------------------------------------------------------
// B. Shoulder abduction
// ---------------------------------------------------------------------------

/**
 * Angle between the shoulder line (hitting shoulder → opposite shoulder) and the
 * upper arm (hitting shoulder → elbow), per frame.
 *
 * Computed in 3D so that an arm swinging out of the image plane is measured
 * honestly — MediaPipe's z carries a usable out-of-plane component.
 */
export function shoulderAbductionSeries(
  frames: readonly PoseFrame[],
  side: HittingSide,
): (number | null)[] {
  const idx = indicesFor(side);
  return frames.map((frame) => {
    const shoulder = getLandmark(frame, idx.shoulder);
    const opposite = getLandmark(frame, idx.oppositeShoulder);
    const elbow = getLandmark(frame, idx.elbow);
    if (!shoulder || !opposite || !elbow) return null;
    return angleAt(spatialPoint(shoulder), spatialPoint(opposite), spatialPoint(elbow));
  });
}

export function classifyAbduction(degrees: number | null): Metric {
  if (degrees == null) {
    return {
      value: null,
      rating: "unknown",
      label: "Shoulder abduction",
      detail:
        "Arm not tracked at contact. Film perpendicular to the player with the whole body in frame.",
    };
  }

  let rating: Rating;
  let detail: string;

  if (degrees < ABDUCTION_DANGER_LOW) {
    rating = "danger";
    detail =
      "Arm too low at contact — elevated impingement risk and reduced reach. Cue a higher contact point.";
  } else if (degrees > ABDUCTION_DANGER_HIGH) {
    rating = "danger";
    detail =
      "Arm hyper-abducted — loads the rotator cuff at end range. Cue contact slightly in front of the shoulder.";
  } else if (degrees >= ABDUCTION_OPTIMAL_LOW && degrees <= ABDUCTION_OPTIMAL_HIGH) {
    rating = "optimal";
    detail = "Elite window — joint space fully used with minimal cuff load.";
  } else {
    rating = "acceptable";
    detail = `Safe range. Target ${ABDUCTION_OPTIMAL_LOW}–${ABDUCTION_OPTIMAL_HIGH}° to fully open the joint.`;
  }

  return {
    value: Math.round(degrees * 10) / 10,
    rating,
    label: "Shoulder abduction at contact",
    detail,
  };
}

// ---------------------------------------------------------------------------
// C. Kinetic chain sequencing
// ---------------------------------------------------------------------------

/**
 * Speed of one landmark across the clip, in torso-lengths per second.
 * Frame intervals come from the recorded timestamps, so variable-rate captures
 * (common on tablets) stay correct.
 */
export function jointSpeedSeries(
  frames: readonly PoseFrame[],
  landmarkIndex: number,
  scales: readonly (number | null)[],
): (number | null)[] {
  const speeds: (number | null)[] = new Array(frames.length).fill(null);

  for (let i = 1; i < frames.length; i += 1) {
    const prev = getLandmark(frames[i - 1], landmarkIndex);
    const cur = getLandmark(frames[i], landmarkIndex);
    const scale = scales[i] ?? null;
    if (!prev || !cur || scale == null) continue;

    const dt = (frames[i]!.timestampMs - frames[i - 1]!.timestampMs) / 1000;
    speeds[i] = speedBetween(pixelPoint(prev), pixelPoint(cur), dt, scale);
  }
  return speeds;
}

/**
 * Verifies the proximal-to-distal firing order hip → shoulder → elbow → wrist.
 *
 * A correct sequence transfers momentum up the chain; when the hip peaks at or
 * after the wrist the player is swinging with the arm alone, which is both
 * slower and harder on the shoulder.
 */
export function analyzeKineticChain(
  frames: readonly PoseFrame[],
  side: HittingSide,
  scales: readonly (number | null)[],
): KineticChainResult {
  const idx = indicesFor(side);
  const joints: { joint: JointSeries["joint"]; index: number }[] = [
    { joint: "hip", index: idx.hip },
    { joint: "shoulder", index: idx.shoulder },
    { joint: "elbow", index: idx.elbow },
    { joint: "wrist", index: idx.wrist },
  ];

  const series: JointSeries[] = joints.map(({ joint, index }) => {
    const speed = jointSpeedSeries(frames, index, scales);
    const peakFrame = argMax(speed);
    return {
      joint,
      speed,
      peakFrame,
      peakSpeed: peakFrame >= 0 ? (speed[peakFrame] ?? null) : null,
    };
  });

  const tracked = series.filter((s) => s.peakFrame >= 0);
  if (tracked.length < series.length) {
    return {
      series,
      isSequenced: false,
      observedOrder: tracked
        .slice()
        .sort((a, b) => a.peakFrame - b.peakFrame)
        .map((s) => s.joint),
      rating: "unknown",
      message:
        "Kinetic chain incomplete: one or more joints were not tracked for the full swing.",
    };
  }

  const observedOrder = series
    .slice()
    .sort((a, b) => a.peakFrame - b.peakFrame)
    .map((s) => s.joint);

  const [hip, shoulder, elbow, wrist] = series as [
    JointSeries,
    JointSeries,
    JointSeries,
    JointSeries,
  ];
  const isSequenced =
    hip.peakFrame < shoulder.peakFrame &&
    shoulder.peakFrame < elbow.peakFrame &&
    elbow.peakFrame < wrist.peakFrame;

  // The headline fault: the hip contributes nothing because it fires last.
  if (hip.peakFrame >= wrist.peakFrame) {
    return {
      series,
      isSequenced: false,
      observedOrder,
      rating: "danger",
      message:
        "Broken Kinetic Chain: Arm-forced strike. Emphasize early hip rotation.",
    };
  }

  if (isSequenced) {
    return {
      series,
      isSequenced: true,
      observedOrder,
      rating: "optimal",
      message:
        "Clean proximal-to-distal sequencing — hip drives shoulder drives elbow drives wrist.",
    };
  }

  return {
    series,
    isSequenced: false,
    observedOrder,
    rating: "acceptable",
    message: `Partial sequencing (${observedOrder.join(" → ")}). Momentum leaks between segments; drill the separation between hip and shoulder rotation.`,
  };
}

// ---------------------------------------------------------------------------
// D. Elbow extension timing
// ---------------------------------------------------------------------------

/** Elbow flexion angle per frame: 180° is a fully straight arm. */
export function elbowFlexionSeries(
  frames: readonly PoseFrame[],
  side: HittingSide,
): (number | null)[] {
  const idx = indicesFor(side);
  return frames.map((frame) => {
    const shoulder = getLandmark(frame, idx.shoulder);
    const elbow = getLandmark(frame, idx.elbow);
    const wrist = getLandmark(frame, idx.wrist);
    if (!shoulder || !elbow || !wrist) return null;
    return angleAt(spatialPoint(elbow), spatialPoint(shoulder), spatialPoint(wrist));
  });
}

/**
 * Ball contact is taken as the frame of peak wrist speed — on a spike the wrist
 * decelerates immediately after impact, so the peak sits within a frame of it.
 */
export function detectContactFrame(
  frames: readonly PoseFrame[],
  side: HittingSide,
  scales: readonly (number | null)[],
): number | null {
  const idx = indicesFor(side);
  const peak = argMax(jointSpeedSeries(frames, idx.wrist, scales));
  return peak >= 0 ? peak : null;
}

/**
 * End of the cocking phase — the frame of maximum shoulder rotation, i.e. the
 * instant the hand stops travelling backwards and reverses toward the ball.
 *
 * Measured as the frame at which the wrist sits furthest *behind* the shoulder
 * along the hitting direction. Deliberately independent of the elbow: defining
 * cocking-end by peak elbow flexion would place it immediately before extension
 * by construction, collapsing the whip/push ratio to ~0 for every player.
 *
 * @returns null when the arm was not tracked, or when the reversal lands too
 *          close to contact to time anything.
 */
export function detectCockingEndFrame(
  frames: readonly PoseFrame[],
  side: HittingSide,
  contactFrame: number,
): number | null {
  const idx = indicesFor(side);

  const contactShoulder = getLandmark(frames[contactFrame], idx.shoulder);
  const contactWrist = getLandmark(frames[contactFrame], idx.wrist);
  let direction = 0;
  if (contactShoulder && contactWrist) {
    direction = Math.sign(contactWrist.pixelX - contactShoulder.pixelX);
  }
  if (direction === 0) {
    // Fall back to the direction the player is travelling.
    const firstHip = getLandmark(frames[0], idx.hip);
    const lastHip = getLandmark(frames[frames.length - 1], idx.hip);
    if (!firstHip || !lastHip) return null;
    direction = Math.sign(lastHip.pixelX - firstHip.pixelX) || 1;
  }

  // Signed forward reach of the hand relative to its own shoulder.
  const reach: (number | null)[] = [];
  for (let i = 0; i < contactFrame; i += 1) {
    const shoulder = getLandmark(frames[i], idx.shoulder);
    const wrist = getLandmark(frames[i], idx.wrist);
    reach.push(shoulder && wrist ? direction * (wrist.pixelX - shoulder.pixelX) : null);
  }

  // Take the LAST reversal before contact, not the global minimum: during the
  // approach the arm also hangs behind the body, and that earlier, deeper
  // minimum is not the cocking phase.
  for (let i = reach.length - 2; i >= 1; i -= 1) {
    const here = reach[i];
    const before = reach[i - 1];
    const after = reach[i + 1];
    if (here == null || before == null || after == null) continue;
    if (here <= before && here <= after) return i;
  }

  const frame = argMin(reach);
  return frame >= 0 ? frame : null;
}

/**
 * Rates the stretch-shortening cycle by *when*, within the cocking-end→contact
 * window, the elbow starts to extend.
 *
 * Onset is the first frame after cocking-end at which the elbow opens faster
 * than 15% of its peak extension rate; that ignores the slow drift preceding
 * the real whip without waiting for the rate to top out.
 */
export function analyzeElbowTiming(
  frames: readonly PoseFrame[],
  side: HittingSide,
  elbowSeries: readonly (number | null)[],
  contactFrame: number | null,
): ElbowTimingResult {
  const unknown = (detail: string): ElbowTimingResult => ({
    cockingEndFrame: null,
    contactFrame,
    extensionOnsetFrame: null,
    onsetRatio: null,
    rating: "unknown",
    label: "Elbow extension timing",
    detail,
  });

  if (contactFrame == null || contactFrame < 2) {
    return unknown("Could not locate ball contact. Trim the clip to the swing itself.");
  }

  const cockingEndFrame = detectCockingEndFrame(frames, side, contactFrame);
  if (cockingEndFrame == null) {
    return unknown("Hitting arm not tracked during the cocking phase.");
  }

  const swingFrames = contactFrame - cockingEndFrame;
  if (swingFrames < 2) {
    return unknown(
      "Swing phase too short to time (fewer than 2 frames). Record at a higher frame rate.",
    );
  }

  // Angular velocity of the elbow; positive means extending.
  const meanDt = averageDt(frames);
  const angularVelocity = derivative(elbowSeries, meanDt);
  const swingVelocities = angularVelocity.slice(cockingEndFrame, contactFrame + 1);
  const peakIndex = argMax(swingVelocities);
  const peakRate = peakIndex >= 0 ? swingVelocities[peakIndex] : null;

  if (peakRate == null || peakRate <= 0) {
    return unknown("No elbow extension detected between cocking and contact.");
  }

  const onsetThreshold = peakRate * 0.15;
  let extensionOnsetFrame: number | null = null;
  for (let i = 0; i < swingVelocities.length; i += 1) {
    const v = swingVelocities[i];
    if (v != null && v >= onsetThreshold) {
      extensionOnsetFrame = cockingEndFrame + i;
      break;
    }
  }

  if (extensionOnsetFrame == null) {
    return unknown("Elbow extension onset could not be resolved.");
  }

  const onsetRatio = (extensionOnsetFrame - cockingEndFrame) / swingFrames;

  let rating: Rating;
  let label: string;
  let detail: string;

  if (onsetRatio < WHIP_ONSET_RATIO) {
    rating = "optimal";
    label = "Whip Action (Early SSC Activation)";
    detail =
      "Elbow releases early in the swing — elastic energy from the cocking phase is being converted into hand speed.";
  } else if (onsetRatio > PUSH_ONSET_RATIO) {
    rating = "danger";
    label = "Push Action (Low Velocity & High Strain)";
    detail =
      "Elbow stays locked until late in the swing, so the ball is pushed rather than whipped. Drill relaxed arm swings with a late, loose hand.";
  } else {
    rating = "acceptable";
    label = "Mixed Action";
    detail = `Extension starts at ${Math.round(onsetRatio * 100)}% of the swing. Aim for under ${Math.round(
      WHIP_ONSET_RATIO * 100,
    )}% to unlock the whip.`;
  }

  return {
    cockingEndFrame,
    contactFrame,
    extensionOnsetFrame,
    onsetRatio,
    rating,
    label,
    detail,
  };
}

function averageDt(frames: readonly PoseFrame[]): number {
  if (frames.length < 2) return 1 / 30;
  const span = frames[frames.length - 1]!.timestampMs - frames[0]!.timestampMs;
  const dt = span / (frames.length - 1) / 1000;
  return dt > 0 ? dt : 1 / 30;
}

// ---------------------------------------------------------------------------
// Full-sequence analysis
// ---------------------------------------------------------------------------

export interface AnalyzeOptions {
  /** Override automatic hitting-arm detection. */
  hittingSide?: HittingSide;
}

/**
 * Runs A–D over a (already smoothed) pose sequence and returns everything the
 * dashboard renders. Never throws: unusable input surfaces as `unknown` ratings
 * plus a warning the coach can act on.
 */
export function analyzeSequence(
  sequence: PoseSequence,
  options: AnalyzeOptions = {},
): SpikeAnalysis {
  const { frames } = sequence;
  const warnings: string[] = [];
  const hittingSide = options.hittingSide ?? detectHittingSide(frames);

  const scales = resolvedScales(frames);
  const trackedFrames = scales.filter((s) => s != null).length;
  if (frames.length > 0 && trackedFrames / frames.length < 0.6) {
    warnings.push(
      "The trunk was tracked in fewer than 60% of frames. Make sure the camera is perpendicular to the player and the whole body stays in frame.",
    );
  }

  const abductionSeries = shoulderAbductionSeries(frames, hittingSide);
  const elbowSeries = elbowFlexionSeries(frames, hittingSide);
  const contactFrame = detectContactFrame(frames, hittingSide, scales);
  const kineticChain = analyzeKineticChain(frames, hittingSide, scales);
  const elbowTiming = analyzeElbowTiming(frames, hittingSide, elbowSeries, contactFrame);

  const abductionAtContact = classifyAbduction(
    contactFrame != null ? (abductionSeries[contactFrame] ?? null) : null,
  );

  if (contactFrame == null) {
    warnings.push(
      "No clear contact moment found. Trim the clip so it starts at the approach and ends just after the hit.",
    );
  }

  return {
    technique: "spike",
    hittingSide,
    // Mirrors contactFrame: for a spike the shell's "key moment" IS ball contact.
    keyFrame: contactFrame,
    contactFrame,
    scaleFactors: scales,
    abductionSeries,
    elbowSeries,
    abductionAtContact,
    kineticChain,
    elbowTiming,
    warnings,
  };
}

export { LM };
