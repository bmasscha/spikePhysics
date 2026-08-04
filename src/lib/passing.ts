/**
 * passing.ts — serve-receive (passing) biomechanics.
 *
 * Mirrors biomechanics.ts in structure and voice, but everything here reads
 * `frame.worldLandmarks` (metric, camera-agnostic) instead of the pixel track,
 * and orientation-type quantities go through bodyFrame.ts rather than a raw
 * camera axis — see that module's header for why: this technique is filmed at
 * ~45°, not side-on, so pixel-space angles would silently encode the tripod's
 * position instead of the player's technique.
 *
 * This file is deliberately self-contained: it depends only on vectorMath,
 * bodyFrame and landmarks, never on biomechanics.ts (the spike's file), so the
 * two techniques can be edited independently without one breaking the other.
 *
 * Never throws. Unusable input (no world landmarks, a joint that never
 * tracks, a contact frame that can't be found) becomes nulls plus a warning
 * the coach can act on, exactly as the spike does.
 */

import {
  angleAt,
  distance,
  magnitude,
  midpoint,
  scale,
  subtract,
  type Vec3,
} from "./vectorMath";
import { angleFromHorizontal, bodyFrameAt, getWorldLandmark, toBodyFrame } from "./bodyFrame";
import { CORE_LANDMARKS, detectHittingSide, LM } from "./landmarks";
import type {
  ContactSource,
  Reading,
  ReadingGroup,
  ServeReceiveAnalysis,
  ServeReceiveSeries,
} from "../types/serveReceive";
import type { AnalyzeOptions } from "../types/technique";
import type { PoseFrame, PoseSequence } from "../types/pose";

// ---------------------------------------------------------------------------
// MediaPipe indices not carried by landmarks.ts
// ---------------------------------------------------------------------------

// LM (landmarks.ts) only names the joints the spike needs. The ankle angle
// needs the forefoot too — the same raw MediaPipe Pose indices mockPass.ts
// uses to build it; see that file's identical comment and the 33-point layout
// at https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker.
// The heels (29, 30) are modelled by the mock but unused here: foot-index
// gives the longer, better-conditioned forefoot vector for the same angle.
const LEFT_FOOT_INDEX = 31;
const RIGHT_FOOT_INDEX = 32;

type Side = "left" | "right";

interface SideIndices {
  shoulder: number;
  elbow: number;
  wrist: number;
  hip: number;
  knee: number;
  ankle: number;
  footIndex: number;
}

const SIDE_INDICES: Record<Side, SideIndices> = {
  left: {
    shoulder: LM.LEFT_SHOULDER,
    elbow: LM.LEFT_ELBOW,
    wrist: LM.LEFT_WRIST,
    hip: LM.LEFT_HIP,
    knee: LM.LEFT_KNEE,
    ankle: LM.LEFT_ANKLE,
    footIndex: LEFT_FOOT_INDEX,
  },
  right: {
    shoulder: LM.RIGHT_SHOULDER,
    elbow: LM.RIGHT_ELBOW,
    wrist: LM.RIGHT_WRIST,
    hip: LM.RIGHT_HIP,
    knee: LM.RIGHT_KNEE,
    ankle: LM.RIGHT_ANKLE,
    footIndex: RIGHT_FOOT_INDEX,
  },
};

// ---------------------------------------------------------------------------
// Small local helpers (deliberately not imported from biomechanics.ts — see
// the file header on why this module stays independent of the spike's).
// ---------------------------------------------------------------------------

/** Median of the finite entries, ignoring nulls. Used for warning thresholds and as a noise-floor estimate for contact detection. */
function medianOf(values: readonly (number | null)[]): number | null {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length === 0) return null;
  finite.sort((a, b) => a - b);
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1]! + finite[mid]!) / 2 : finite[mid]!;
}

/** Index of the largest finite value, or -1 when none exists. */
function argMaxOf(values: readonly (number | null)[]): number {
  let bestIndex = -1;
  let best = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (v > best) {
      best = v;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Mean sample interval across the whole clip, in seconds. Fallback only used for a degenerate (<2 frame) sequence. */
function averageDtSeconds(frames: readonly PoseFrame[]): number {
  if (frames.length < 2) return 1 / 30;
  const span = frames[frames.length - 1]!.timestampMs - frames[0]!.timestampMs;
  const dt = span / (frames.length - 1) / 1000;
  return dt > 0 ? dt : 1 / 30;
}

/**
 * First derivative of a scalar series using each pair's *real* frame-to-frame
 * interval (from `timestampMs`), not a fixed dt — mirrors vectorMath's
 * `derivative` but honest about variable-rate captures, which are normal on a
 * tablet. Central difference in the interior, one-sided at the ends. Gaps
 * (null) propagate to anything that depends on them.
 */
function derivativeWithTimestamps(
  values: readonly (number | null)[],
  frames: readonly PoseFrame[],
): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const prev = i > 0 ? values[i - 1] : undefined;
    const next = i < n - 1 ? values[i + 1] : undefined;
    const here = values[i];

    if (prev != null && next != null) {
      const dt = (frames[i + 1]!.timestampMs - frames[i - 1]!.timestampMs) / 1000;
      if (dt > 0) out[i] = (next - prev) / dt;
    } else if (next != null && here != null) {
      const dt = (frames[i + 1]!.timestampMs - frames[i]!.timestampMs) / 1000;
      if (dt > 0) out[i] = (next - here) / dt;
    } else if (prev != null && here != null) {
      const dt = (frames[i]!.timestampMs - frames[i - 1]!.timestampMs) / 1000;
      if (dt > 0) out[i] = (here - prev) / dt;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-frame, per-side geometry
// ---------------------------------------------------------------------------

function sideElbowAngle(frame: PoseFrame, side: Side): number | null {
  const idx = SIDE_INDICES[side];
  const shoulder = getWorldLandmark(frame, idx.shoulder);
  const elbow = getWorldLandmark(frame, idx.elbow);
  const wrist = getWorldLandmark(frame, idx.wrist);
  if (!shoulder || !elbow || !wrist) return null;
  return angleAt(elbow, shoulder, wrist);
}

function sideKneeAngle(frame: PoseFrame, side: Side): number | null {
  const idx = SIDE_INDICES[side];
  const hip = getWorldLandmark(frame, idx.hip);
  const knee = getWorldLandmark(frame, idx.knee);
  const ankle = getWorldLandmark(frame, idx.ankle);
  if (!hip || !knee || !ankle) return null;
  return angleAt(knee, hip, ankle);
}

/** Hip hinge: interior angle at the hip between the (same-side) shoulder and knee. */
function sideHipTrunkAngle(frame: PoseFrame, side: Side): number | null {
  const idx = SIDE_INDICES[side];
  const hip = getWorldLandmark(frame, idx.hip);
  const shoulder = getWorldLandmark(frame, idx.shoulder);
  const knee = getWorldLandmark(frame, idx.knee);
  if (!hip || !shoulder || !knee) return null;
  return angleAt(hip, shoulder, knee);
}

/** Upper arm vs trunk: interior angle at the shoulder between the hip and the elbow. */
function sideArmTrunkAngle(frame: PoseFrame, side: Side): number | null {
  const idx = SIDE_INDICES[side];
  const shoulder = getWorldLandmark(frame, idx.shoulder);
  const hip = getWorldLandmark(frame, idx.hip);
  const elbow = getWorldLandmark(frame, idx.elbow);
  if (!shoulder || !hip || !elbow) return null;
  return angleAt(shoulder, hip, elbow);
}

/**
 * Ankle angle: shank (knee->ankle) vs the forefoot (ankle->foot-index),
 * measured as the interior angle at the ankle. The lowest-confidence trace —
 * feet are small on screen and the first landmarks MediaPipe loses.
 */
function sideAnkleAngle(frame: PoseFrame, side: Side): number | null {
  const idx = SIDE_INDICES[side];
  const knee = getWorldLandmark(frame, idx.knee);
  const ankle = getWorldLandmark(frame, idx.ankle);
  const footIndex = getWorldLandmark(frame, idx.footIndex);
  if (!knee || !ankle || !footIndex) return null;
  return angleAt(ankle, knee, footIndex);
}

/** Forearm line (elbow->wrist) vs true horizontal — the "platform" for one arm. */
function sidePlatformInclination(frame: PoseFrame, side: Side): number | null {
  const idx = SIDE_INDICES[side];
  const elbow = getWorldLandmark(frame, idx.elbow);
  const wrist = getWorldLandmark(frame, idx.wrist);
  if (!elbow || !wrist) return null;
  return angleFromHorizontal(subtract(wrist, elbow));
}

function shoulderTiltForFrame(frame: PoseFrame): number | null {
  const left = getWorldLandmark(frame, LM.LEFT_SHOULDER);
  const right = getWorldLandmark(frame, LM.RIGHT_SHOULDER);
  if (!left || !right) return null;
  return angleFromHorizontal(subtract(right, left));
}

function wristMidpoint(frame: PoseFrame): Vec3 | null {
  const left = getWorldLandmark(frame, LM.LEFT_WRIST);
  const right = getWorldLandmark(frame, LM.RIGHT_WRIST);
  if (!left || !right) return null;
  return midpoint(left, right);
}

function ankleMidpoint(frame: PoseFrame): Vec3 | null {
  const left = getWorldLandmark(frame, LM.LEFT_ANKLE);
  const right = getWorldLandmark(frame, LM.RIGHT_ANKLE);
  if (!left || !right) return null;
  return midpoint(left, right);
}

/**
 * Combines a per-side reading across both arms/legs by averaging whichever
 * side(s) are tracked — the platform (or stance) is a pair, so a value from
 * one arm/leg is still meaningful when the other drops out of tracking.
 */
function averageOfSides(
  frame: PoseFrame,
  fn: (frame: PoseFrame, side: Side) => number | null,
): number | null {
  const left = fn(frame, "left");
  const right = fn(frame, "right");
  if (left != null && right != null) return (left + right) / 2;
  return left ?? right ?? null;
}

/**
 * Combines a per-side angle by taking the STRAIGHTER (larger) of the two —
 * used only for the elbow. Arms-straight is the thing being measured, so a
 * dropped-out arm reading as "bent" (by defaulting to the other, possibly
 * bent, side) would be the wrong failure mode; taking the max means a
 * genuinely straight arm is never masked by the other side's tracking noise.
 */
function straighterOfSides(
  frame: PoseFrame,
  fn: (frame: PoseFrame, side: Side) => number | null,
): number | null {
  const left = fn(frame, "left");
  const right = fn(frame, "right");
  if (left != null && right != null) return Math.max(left, right);
  return left ?? right ?? null;
}

// ---------------------------------------------------------------------------
// Series (one entry per frame — what the charts draw)
// ---------------------------------------------------------------------------

function buildSeries(frames: readonly PoseFrame[]): ServeReceiveSeries {
  const platformInclination = frames.map((f) => averageOfSides(f, sidePlatformInclination));
  const shoulderTilt = frames.map((f) => shoulderTiltForFrame(f));
  const elbow = frames.map((f) => straighterOfSides(f, sideElbowAngle));
  const knee = frames.map((f) => averageOfSides(f, sideKneeAngle));
  const hipTrunk = frames.map((f) => averageOfSides(f, sideHipTrunkAngle));
  const armTrunk = frames.map((f) => averageOfSides(f, sideArmTrunkAngle));
  const ankle = frames.map((f) => averageOfSides(f, sideAnkleAngle));

  const ankleMidpoints = frames.map((f) => ankleMidpoint(f));
  const footSpeed = pointSpeedSeries(frames, ankleMidpoints);

  // Hip-rise speed cannot be read off the hip landmark's own vertical motion:
  // MediaPipe's world landmarks are re-centred on the hip midpoint EVERY
  // frame (see WorldLandmark's doc comment and bodyFrame.ts's header), so the
  // hip sits exactly at the origin in every single frame and carries no
  // motion signal at all — differentiating it would just return zero. A real
  // leg drive with the feet planted instead shows up the other way round: the
  // ankles recede further from the (fixed) hip as the hip rises away from the
  // ground (see mockPass.ts's legDriveMeters comment, which documents the
  // identical fact about MediaPipe's own coordinate convention, not a mock
  // limitation). World y is DOWN, so "further from the hip, toward the
  // floor" is a *larger* y — meaning the ankle's y coordinate INCREASING is
  // what a rising hip looks like, and no sign flip is needed here (unlike a
  // literal "vertical speed", where DOWN-positive would need negating).
  const ankleMidY = ankleMidpoints.map((p) => (p ? p.y : null));
  const hipRiseSpeed = derivativeWithTimestamps(ankleMidY, frames);

  const platformAngularSpeed = derivativeWithTimestamps(platformInclination, frames);

  return {
    platformInclination,
    shoulderTilt,
    elbow,
    knee,
    hipTrunk,
    armTrunk,
    ankle,
    footSpeed,
    hipRiseSpeed,
    platformAngularSpeed,
  };
}

/**
 * Speed (m/s) of a tracked point across consecutive frames, using the real
 * frame-to-frame interval from `timestampMs` — never the frame index, since
 * variable-rate captures are normal on a tablet.
 */
function pointSpeedSeries(
  frames: readonly PoseFrame[],
  points: readonly (Vec3 | null)[],
): (number | null)[] {
  const out: (number | null)[] = new Array(frames.length).fill(null);
  for (let i = 1; i < frames.length; i += 1) {
    const prev = points[i - 1];
    const cur = points[i];
    if (!prev || !cur) continue;
    const dt = (frames[i]!.timestampMs - frames[i - 1]!.timestampMs) / 1000;
    if (!(dt > 0)) continue;
    out[i] = distance(cur, prev) / dt;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Contact detection
// ---------------------------------------------------------------------------

// A pass only exists while the platform exists: arms brought together and
// reasonably extended. 90° excludes a hanging/relaxed arm; 0.5m is a
// generous "still joined" gate (a broken/separating platform, not a tight
// one) so the detector isn't starved of eligible frames on imperfect
// technique — see handSeparationMeters's own doc comment for what "coming
// apart" looks like in the mock.
const ARM_EXTENDED_MIN_DEG = 90;
const ARMS_JOINED_MAX_M = 0.5;

// A peak must clear the noise floor by a wide margin before it is trusted as
// a real kinematic event rather than jitter left over after smoothing.
const PEAK_PROMINENCE_MULTIPLIER = 3;
const PEAK_MIN_ABSOLUTE_MPSS = 0.05;

// Two edges of the same swing window should never be mistaken for one another
// (they are seconds-scale apart in real technique); this just stops a single
// noisy spike from being double-counted as two adjacent "peaks".
const MIN_PEAK_SEPARATION_SECONDS = 0.05;

// Corroboration weight for the leg-drive tie-break, in (m/s^2)-equivalent
// penalty per frame of distance from the hip-rise peak. Deliberately small:
// per the brief, leg drive disambiguates between near-equally strong
// candidate impulses, it never outweighs a clearly stronger one.
const HIP_RISE_TIEBREAK_WEIGHT = 0.02;

function armsJoinedAndExtended(frame: PoseFrame): boolean {
  const left = getWorldLandmark(frame, LM.LEFT_WRIST);
  const right = getWorldLandmark(frame, LM.RIGHT_WRIST);
  if (!left || !right) return false;
  if (distance(left, right) > ARMS_JOINED_MAX_M) return false;
  const elbow = straighterOfSides(frame, sideElbowAngle);
  return elbow != null && elbow >= ARM_EXTENDED_MIN_DEG;
}

/**
 * Magnitude of the wrist midpoint's acceleration, per frame — the "sharpest
 * change in velocity" signal the brief asks for. Computed by differentiating
 * position twice with the real per-frame interval; the sequence is expected
 * to already be smoothed (see TechniqueDefinition.analyze's doc comment),
 * since double-differentiating raw landmark noise amplifies it far past
 * anything a ball impulse produces.
 */
function wristAccelMagnitudeSeries(frames: readonly PoseFrame[]): (number | null)[] {
  const positions = frames.map((f) => wristMidpoint(f));
  const n = frames.length;
  const velocity: (Vec3 | null)[] = new Array(n).fill(null);

  for (let i = 1; i < n; i += 1) {
    const prev = positions[i - 1];
    const cur = positions[i];
    if (!prev || !cur) continue;
    const dt = (frames[i]!.timestampMs - frames[i - 1]!.timestampMs) / 1000;
    if (!(dt > 0)) continue;
    velocity[i] = scale(subtract(cur, prev), 1 / dt);
  }

  const accel: (number | null)[] = new Array(n).fill(null);
  for (let i = 1; i < n; i += 1) {
    const prev = velocity[i - 1];
    const cur = velocity[i];
    if (!prev || !cur) continue;
    const dt = (frames[i]!.timestampMs - frames[i - 1]!.timestampMs) / 1000;
    if (!(dt > 0)) continue;
    accel[i] = magnitude(scale(subtract(cur, prev), 1 / dt));
  }
  return accel;
}

interface Peak {
  index: number;
  value: number;
}

/** Local maxima above `minProminence`, at least `minSeparation` frames apart (greedy: strongest first). */
function findPeaks(series: readonly (number | null)[], minSeparation: number, minProminence: number): Peak[] {
  const raw: Peak[] = [];
  for (let i = 1; i < series.length - 1; i += 1) {
    const v = series[i];
    if (v == null || v <= minProminence) continue;
    const prev = series[i - 1];
    const next = series[i + 1];
    if (v >= (prev ?? -Infinity) && v >= (next ?? -Infinity)) raw.push({ index: i, value: v });
  }
  raw.sort((a, b) => b.value - a.value);
  const kept: Peak[] = [];
  for (const p of raw) {
    if (kept.every((k) => Math.abs(k.index - p.index) >= minSeparation)) kept.push(p);
  }
  return kept.sort((a, b) => a.index - b.index);
}

/**
 * Infers ball contact from the platform's motion, since MediaPipe never sees
 * the ball itself (see ContactSource's doc comment in types/serveReceive.ts).
 *
 * A quiet-then-moving-then-quiet-again platform brackets contact between two
 * kinematic transitions — the arm accelerating as the ball loads it, and
 * decelerating again as the pass is released — which is a better feature to
 * detect than a single instant of peak motion, because a real swing's
 * acceleration is roughly *constant* through its middle (the classic
 * signature of an arm rotating at a steady rate) rather than peaked there.
 * When only one such transition is found (e.g. contact sits right at the edge
 * of the clip, or the platform never settles again) that single transition is
 * used directly, on the reasoning that it is still the best available
 * evidence, just with less bracketing confidence.
 *
 * How well this actually works, measured in passing.test.ts rather than
 * asserted here — and the honest answer is "it depends on the pass":
 *
 *   - A platform swung through the ball (a real coaching fault, and a large
 *     kinematic event) is found to within a frame or two through several
 *     millimetres of landmark jitter.
 *   - A well-played, quiet platform is NOT found at realistic jitter, and this
 *     returns null. Double-differentiating a ~1cm-noisy world landmark yields
 *     a noise floor around 13 m/s^2 against a true contact signature of about
 *     0.26 m/s^2 — fifty times the signal, which no threshold recovers.
 *
 * That second case is the technique working, not the detector failing: good
 * passing is nearly motionless at contact, which is precisely why the coach
 * can mark it (see AnalyzeOptions.keyFrame) and why the manual path is the
 * expected one on a well-executed pass rather than a fallback.
 *
 * Leg drive corroborates only: candidate bracket pairs are scored primarily
 * by how strong their two transitions are, and only tie-broken by proximity
 * to the frame of fastest hip rise (a pass usually sits near the peak of the
 * leg drive) — never used to override a clearly stronger impulse pair.
 *
 * @returns null when no eligible platform motion stands out at all. A
 *   confidently wrong contact frame is worse than none: every reading in the
 *   result is defined at or around this frame.
 */
export function detectPassContactFrame(frames: readonly PoseFrame[]): number | null {
  if (frames.length < 5) return null;

  const eligible = frames.map((f) => armsJoinedAndExtended(f));
  const rawAccel = wristAccelMagnitudeSeries(frames);
  const accel = rawAccel.map((v, i) => (eligible[i] ? v : null));

  const background = medianOf(accel) ?? 0;
  const prominence = Math.max(background * PEAK_PROMINENCE_MULTIPLIER, PEAK_MIN_ABSOLUTE_MPSS);

  const avgDt = averageDtSeconds(frames);
  const minSeparationFrames = Math.max(2, Math.round(MIN_PEAK_SEPARATION_SECONDS / avgDt));

  const peaks = findPeaks(accel, minSeparationFrames, prominence);
  if (peaks.length === 0) return null;
  if (peaks.length === 1) return peaks[0]!.index;

  const ankleMidY = frames.map((f) => {
    const p = ankleMidpoint(f);
    return p ? p.y : null;
  });
  const hipRiseSpeed = derivativeWithTimestamps(ankleMidY, frames);
  const hipRisePeakIndex = argMaxOf(hipRiseSpeed);

  let best: { midpoint: number; score: number } | null = null;
  for (let i = 0; i < peaks.length - 1; i += 1) {
    const a = peaks[i]!;
    const b = peaks[i + 1]!;
    const mid = (a.index + b.index) / 2;
    const magnitudeScore = a.value + b.value;
    const distancePenalty = hipRisePeakIndex >= 0 ? Math.abs(mid - hipRisePeakIndex) : 0;
    const score = magnitudeScore - distancePenalty * HIP_RISE_TIEBREAK_WEIGHT;
    if (best == null || score > best.score) best = { midpoint: mid, score };
  }
  return best ? Math.round(best.midpoint) : null;
}

// ---------------------------------------------------------------------------
// Contact-frame readings
// ---------------------------------------------------------------------------

function at(series: readonly (number | null)[], frame: number | null): number | null {
  if (frame == null) return null;
  return series[frame] ?? null;
}

function handSeparationAtCm(frames: readonly PoseFrame[], contactFrame: number | null): number | null {
  if (contactFrame == null) return null;
  const frame = frames[contactFrame];
  if (!frame) return null;
  const left = getWorldLandmark(frame, LM.LEFT_WRIST);
  const right = getWorldLandmark(frame, LM.RIGHT_WRIST);
  if (!left || !right) return null;
  return distance(left, right) * 100; // metres -> centimetres
}

/**
 * Vertical hip rise from the most-loaded (lowest) point before contact up to
 * the contact frame, in metres. Built on the same ankle-recession proxy as
 * `hipRiseSpeed` (see buildSeries's comment on why the hip landmark's own
 * position cannot be used directly) — the minimum is taken over the whole
 * pre-contact window rather than a fixed time span, so it finds the deepest
 * crouch wherever it actually occurred rather than assuming its timing.
 */
function hipRiseThroughContact(frames: readonly PoseFrame[], contactFrame: number | null): number | null {
  if (contactFrame == null) return null;
  const contactY = ankleMidpoint(frames[contactFrame]!)?.y ?? null;
  if (contactY == null) return null;

  let loadedY: number | null = null;
  for (let i = 0; i <= contactFrame; i += 1) {
    const y = ankleMidpoint(frames[i]!)?.y ?? null;
    if (y != null && (loadedY == null || y < loadedY)) loadedY = y;
  }
  if (loadedY == null) return null;
  return contactY - loadedY;
}

/** Forward component (body frame) of the wrist midpoint at the contact frame — positive is in front of the body. */
function contactForwardOffset(frames: readonly PoseFrame[], contactFrame: number | null): number | null {
  if (contactFrame == null) return null;
  const frame = frames[contactFrame];
  if (!frame) return null;
  const basis = bodyFrameAt(frame);
  if (!basis) return null;
  const wrist = wristMidpoint(frame);
  if (!wrist) return null;
  return toBodyFrame(wrist, basis).forward;
}

function buildGroups(
  frames: readonly PoseFrame[],
  series: ServeReceiveSeries,
  contactFrame: number | null,
): ReadingGroup[] {
  const kneeAngularSpeed = derivativeWithTimestamps(series.knee, frames);

  const platform: Reading[] = [
    {
      label: "Platform inclination",
      value: at(series.platformInclination, contactFrame),
      unit: "°",
      detail:
        "Angle of the forearm line above true horizontal at the contact frame, averaged across both arms.",
    },
    {
      label: "Elbow angle",
      value: at(series.elbow, contactFrame),
      unit: "°",
      detail:
        "Interior elbow angle of whichever arm is straighter at the contact frame. 180° is fully extended.",
    },
    {
      label: "Hand separation",
      value: handSeparationAtCm(frames, contactFrame),
      unit: "cm",
      detail: "Straight-line 3D distance between the two wrists at the contact frame.",
    },
    {
      label: "Shoulder tilt",
      value: at(series.shoulderTilt, contactFrame),
      unit: "°",
      detail: "Angle of the line between the shoulders above true horizontal at the contact frame.",
    },
  ];

  const baseAndLegs: Reading[] = [
    {
      label: "Knee angle",
      value: at(series.knee, contactFrame),
      unit: "°",
      detail:
        "Interior knee angle at the contact frame, averaged across both legs when both are tracked. 180° is a straight leg.",
    },
    {
      label: "Knee extension rate",
      value: at(kneeAngularSpeed, contactFrame),
      unit: "°/s",
      detail:
        "Rate of change of the knee angle through the contact frame; positive is extending (standing taller).",
    },
    {
      label: "Foot speed",
      value: at(series.footSpeed, contactFrame),
      unit: "m/s",
      detail:
        "Speed of the midpoint between the two ankles at the contact frame, measured relative to the hips — so a leg drive with the feet planted also registers here, not only a shuffle-step.",
    },
    {
      label: "Hip rise",
      value: hipRiseThroughContact(frames, contactFrame),
      unit: "m",
      detail:
        "Vertical rise of the hips from the most-loaded point before contact up to the contact frame, inferred from how far the ankles recede from the hip.",
    },
  ];

  const postureAndTiming: Reading[] = [
    {
      label: "Hip-trunk angle",
      value: at(series.hipTrunk, contactFrame),
      unit: "°",
      detail: "Interior angle at the hip between the shoulder and the knee at the contact frame — the hip hinge.",
    },
    {
      label: "Contact point (forward)",
      value: contactForwardOffset(frames, contactFrame),
      unit: "m",
      detail:
        "Forward component of the wrist midpoint in the player's own body frame at the contact frame; positive is in front of the body.",
    },
    {
      label: "Platform angular speed",
      value: at(series.platformAngularSpeed, contactFrame),
      unit: "°/s",
      detail: "Rate of change of the platform inclination through the contact frame.",
    },
  ];

  return [
    { title: "Platform at contact", readings: platform },
    { title: "Base and legs", readings: baseAndLegs },
    { title: "Posture and timing", readings: postureAndTiming },
  ];
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

// A shoulder line this far from horizontal, sustained across the clip, is
// implausible as genuine lateral tilt for a receiving stance and far more
// likely to be a rolled camera — see bodyFrame.ts's header and WORLD_UP's
// doc comment on why a rolled tablet silently tilts every gravity-referenced
// angle this technique computes, with no way for the geometry itself to
// detect it.
const IMPLAUSIBLE_SHOULDER_TILT_DEG = 25;

// ---------------------------------------------------------------------------
// Full-sequence analysis
// ---------------------------------------------------------------------------

/**
 * Runs the passing biomechanics over an already-smoothed pose sequence and
 * returns everything the dashboard renders. Never throws.
 */
export function analyzePass(sequence: PoseSequence, options: AnalyzeOptions = {}): ServeReceiveAnalysis {
  const { frames } = sequence;
  const warnings: string[] = [];

  // Passing is two-armed by nature, so "hitting side" is close to meaningless
  // here — there is no single arm doing the work. Reusing detectHittingSide
  // (whichever wrist travels further) at least gives the overlay a
  // deterministic side to mirror off, rather than an arbitrary default; it is
  // not a claim about a "dominant" or "platform" side.
  const hittingSide = detectHittingSide(frames);

  const hasWorldLandmarks = frames.some((f) => (f.worldLandmarks?.length ?? 0) > 0);
  if (!hasWorldLandmarks) {
    warnings.push(
      "This clip has no 3D world landmarks, which every passing measurement depends on (see bodyFrame.ts) — the analysis cannot produce any readings for it.",
    );
  } else {
    const trunkTracked = frames.filter((f) => CORE_LANDMARKS.every((i) => getWorldLandmark(f, i) != null)).length;
    if (frames.length > 0 && trunkTracked / frames.length < 0.6) {
      warnings.push(
        "The trunk was tracked in fewer than 60% of frames. Make sure the camera is roughly 45° to the player and the whole body stays in frame.",
      );
    }
  }

  const series = buildSeries(frames);

  let contactFrame: number | null;
  let contactSource: ContactSource;
  if (options.keyFrame != null) {
    contactFrame = options.keyFrame;
    contactSource = "manual";
  } else {
    contactFrame = detectPassContactFrame(frames);
    contactSource = contactFrame != null ? "detected" : "none";
  }

  if (contactSource === "none") {
    warnings.push(
      "No clear ball contact could be inferred from the platform's motion. Scrub the video to the moment the ball touches the platform and mark it manually.",
    );
  }

  const shoulderTiltMedian = medianOf(series.shoulderTilt);
  if (shoulderTiltMedian != null && Math.abs(shoulderTiltMedian) > IMPLAUSIBLE_SHOULDER_TILT_DEG) {
    warnings.push(
      "The shoulder line sits well off horizontal through most of the clip — check whether the tablet was held level. A rolled camera tilts every angle in this analysis the same way.",
    );
  }

  const groups = buildGroups(frames, series, contactFrame);

  return {
    technique: "serve-receive",
    hittingSide,
    // Mirrors contactFrame: for a pass the shell's "key moment" IS ball
    // contact on the platform.
    keyFrame: contactFrame,
    contactFrame,
    contactSource,
    series,
    groups,
    warnings,
  };
}
