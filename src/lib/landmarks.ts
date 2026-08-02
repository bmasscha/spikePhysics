/**
 * MediaPipe Pose landmark indices, side resolution and skeleton topology.
 * https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
 */

import type { HittingSide, PoseFrame, PoseLandmark } from "../types/pose";

export const LM = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
} as const;

/** Landmark indices that must be visible for any analysis to be meaningful. */
export const CORE_LANDMARKS = [
  LM.LEFT_SHOULDER,
  LM.RIGHT_SHOULDER,
  LM.LEFT_HIP,
  LM.RIGHT_HIP,
] as const;

/** Below this confidence a landmark is treated as not detected. */
export const VISIBILITY_THRESHOLD = 0.5;

export interface SideIndices {
  shoulder: number;
  oppositeShoulder: number;
  elbow: number;
  wrist: number;
  hip: number;
  knee: number;
  ankle: number;
}

export function indicesFor(side: HittingSide): SideIndices {
  return side === "right"
    ? {
        shoulder: LM.RIGHT_SHOULDER,
        oppositeShoulder: LM.LEFT_SHOULDER,
        elbow: LM.RIGHT_ELBOW,
        wrist: LM.RIGHT_WRIST,
        hip: LM.RIGHT_HIP,
        knee: LM.RIGHT_KNEE,
        ankle: LM.RIGHT_ANKLE,
      }
    : {
        shoulder: LM.LEFT_SHOULDER,
        oppositeShoulder: LM.RIGHT_SHOULDER,
        elbow: LM.LEFT_ELBOW,
        wrist: LM.LEFT_WRIST,
        hip: LM.LEFT_HIP,
        knee: LM.LEFT_KNEE,
        ankle: LM.LEFT_ANKLE,
      };
}

/**
 * Returns a landmark only if it exists and is confidently visible, so callers
 * can simply null-check instead of repeating the visibility test.
 */
export function getLandmark(
  frame: PoseFrame | undefined,
  index: number,
  minVisibility = VISIBILITY_THRESHOLD,
): PoseLandmark | null {
  const lm = frame?.landmarks[index];
  if (!lm) return null;
  if (!Number.isFinite(lm.pixelX) || !Number.isFinite(lm.pixelY)) return null;
  if (lm.visibility < minVisibility) return null;
  return lm;
}

/** 2D pixel-space point, for image-plane distances and speeds. */
export function pixelPoint(lm: PoseLandmark): { x: number; y: number } {
  return { x: lm.pixelX, y: lm.pixelY };
}

/**
 * 3D point on a single isotropic scale (pixels), which is the only space in
 * which the angle formulas are valid. See the note on PoseLandmark.pixelZ.
 */
export function spatialPoint(lm: PoseLandmark): { x: number; y: number; z: number } {
  return { x: lm.pixelX, y: lm.pixelY, z: lm.pixelZ };
}

/**
 * Infers the hitting arm from the clip: the wrist that travels the furthest
 * total pixel distance is the swinging one. Falls back to "right" (the majority
 * case) when neither wrist is tracked well enough to decide.
 */
export function detectHittingSide(frames: readonly PoseFrame[]): HittingSide {
  let leftTravel = 0;
  let rightTravel = 0;

  for (let i = 1; i < frames.length; i += 1) {
    for (const [index, isLeft] of [
      [LM.LEFT_WRIST, true],
      [LM.RIGHT_WRIST, false],
    ] as const) {
      const prev = getLandmark(frames[i - 1], index);
      const cur = getLandmark(frames[i], index);
      if (!prev || !cur) continue;
      const travel = Math.hypot(cur.pixelX - prev.pixelX, cur.pixelY - prev.pixelY);
      if (isLeft) leftTravel += travel;
      else rightTravel += travel;
    }
  }

  if (leftTravel === 0 && rightTravel === 0) return "right";
  return leftTravel > rightTravel ? "left" : "right";
}

/** Bone pairs used to draw the skeleton overlay (torso + limbs only). */
export const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
  [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
  [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
  [LM.LEFT_SHOULDER, LM.LEFT_HIP],
  [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.RIGHT_HIP],
  [LM.LEFT_HIP, LM.LEFT_KNEE],
  [LM.LEFT_KNEE, LM.LEFT_ANKLE],
  [LM.RIGHT_HIP, LM.RIGHT_KNEE],
  [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
];
