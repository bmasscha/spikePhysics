/**
 * bodyFrame.ts — a coordinate frame anchored to the player's own body, derived
 * from MediaPipe world landmarks rather than the camera.
 *
 * Why this exists. The spike gets away with camera-space geometry because the
 * app insists on a side-on shot, which puts the swing in the image plane (see
 * the note on `WorldLandmark` in types/pose.ts). Serve-receive is filmed at
 * roughly 45° to the player, and that angle is never exact and never repeats
 * session to session — a coach filming from a tripod eyeballs "about 45°", not
 * 45.0°. Any measurement taken directly in camera axes (x/y/z of the world
 * landmarks) therefore drifts with wherever the tripod happened to be that day,
 * which makes it useless for tracking a player's technique over time or for
 * comparing two players filmed by two different coaches.
 *
 * The fix: build a basis out of the player's own trunk — up the spine, across
 * the hips, and the cross of the two — and re-express every measurement in
 * that basis. The camera can sit anywhere in the room and, so long as the body
 * itself is tracked, the numbers come out the same. That invariance is proven
 * by the "camera-azimuth invariance" test in bodyFrame.test.ts: rotate the
 * whole scene about the vertical axis (simulate re-shooting from a different
 * angle) and every body-frame coordinate is unchanged to floating-point noise.
 *
 * This module is pure geometry: no React, no I/O, no MediaPipe types beyond
 * the plain data shapes in types/pose.ts.
 */

import {
  cross,
  dot,
  EPSILON,
  isFiniteVec,
  midpoint,
  normalize,
  radToDeg,
  scale,
  subtract,
  type Vec,
  type Vec3,
} from "./vectorMath";
import { CORE_LANDMARKS, VISIBILITY_THRESHOLD } from "./landmarks";
import type { PoseFrame, WorldLandmark } from "../types/pose";

// ---------------------------------------------------------------------------
// World-space landmark access
// ---------------------------------------------------------------------------

/**
 * Returns a world landmark only if it exists and is confidently visible, so
 * callers can simply null-check instead of repeating the visibility test.
 * Mirrors `getLandmark` in landmarks.ts, but reads `frame.worldLandmarks`
 * (metres, hip-relative) instead of the pixel-space `frame.landmarks`.
 */
export function getWorldLandmark(
  frame: PoseFrame | undefined,
  index: number,
  minVisibility = VISIBILITY_THRESHOLD,
): WorldLandmark | null {
  const lm = frame?.worldLandmarks?.[index];
  if (!lm) return null;
  if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y) || !Number.isFinite(lm.z)) return null;
  if (lm.visibility < minVisibility) return null;
  return lm;
}

// ---------------------------------------------------------------------------
// The body frame itself
// ---------------------------------------------------------------------------

/**
 * An orthonormal basis anchored to the player's trunk, all three axes unit
 * length and mutually perpendicular.
 *
 *   - `up`      toward the head (see `bodyFrameAt` for the y-DOWN sign note).
 *   - `lateral` toward the player's own anatomical right.
 *   - `forward` the direction the player is facing.
 */
export interface BodyFrameBasis {
  /** Hip midpoint, in world (metric) space. */
  origin: Vec3;
  up: Vec3;
  lateral: Vec3;
  forward: Vec3;
}

/** A point expressed relative to a `BodyFrameBasis`, in metres along each axis. */
export interface BodyFrameCoordinates {
  lateral: number;
  up: number;
  forward: number;
}

/**
 * Builds the body frame for one pose frame, or `null` when the four trunk
 * landmarks (`CORE_LANDMARKS`) are not all confidently tracked — with a
 * degenerate trunk (e.g. hips and shoulders coincident) there is no reliable
 * "up" or "lateral" to build from, and returning a bogus basis would be worse
 * than refusing.
 */
export function bodyFrameAt(frame: PoseFrame | undefined): BodyFrameBasis | null {
  const [leftShoulder, rightShoulder, leftHip, rightHip] = CORE_LANDMARKS.map((i) =>
    getWorldLandmark(frame, i),
  );
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return null;

  const hipMid = midpoint(leftHip, rightHip);
  const shoulderMid = midpoint(leftShoulder, rightShoulder);

  // "up" points toward the head: hip midpoint -> shoulder midpoint. World y is
  // DOWN (see WorldLandmark), so for an upright player this subtraction lands
  // with a *negative* y component — that is correct and expected, not a bug.
  // "up" in the anatomical sense is negative y in this coordinate system;
  // do not "fix" the sign here, and do not assume `up.y` is positive elsewhere.
  const up = normalize(subtract(shoulderMid, hipMid));
  if (!up) return null;

  // "lateral" points toward the player's own right. Built from the anatomical
  // hip line (RIGHT_HIP - LEFT_HIP) rather than a raw world axis, because which
  // way "the player's right" points in camera x/z depends entirely on which
  // way they happen to be facing the camera that day — exactly the dependency
  // this module exists to remove.
  //
  // The raw hip line is not assumed perpendicular to the spine (a real trunk
  // never is exactly square), so it is Gram-Schmidt orthogonalized against
  // `up`: subtract the component of the hip line that lies along `up`, then
  // normalize what is left.
  const lateralRaw = subtract(rightHip, leftHip);
  const lateralOrthogonal = subtract(lateralRaw, scale(up, dot(lateralRaw, up)));
  const lateral = normalize(lateralOrthogonal);
  if (!lateral) return null;

  // "forward" is the direction the player faces, built as a cross product of
  // the other two axes — and the order is a genuine trap, because it depends on
  // a z convention that is easy to state backwards. MediaPipe's z grows AWAY
  // from the camera ("the smaller the value the closer the landmark is to the
  // camera"), so a player facing the lens faces -z.
  //
  // Work it through with that player: their anatomical right is on the image's
  // left, so lateral = (-1, 0, 0), and up = (0, -1, 0) since y is DOWN.
  // cross(lateral, up) = (0, 0, +1), which points out of their back.
  // cross(up, lateral) = (0, 0, -1), toward the camera — the way they face.
  //
  // Pinned by the handedness tests in bodyFrame.test.ts. If you swap this
  // order, they fail loudly, which is the point: an inverted `forward` silently
  // turns "contact in front of the body" into "behind" and every number built
  // on it still looks plausible.
  const forward = normalize(cross(up, lateral));
  if (!forward) return null;

  return { origin: hipMid, up, lateral, forward };
}

/**
 * Expresses a world-space point relative to a body frame: how far it sits
 * along each of the frame's three axes, in metres, measured from `basis.origin`.
 *
 * This is what turns a body-relative question like "is the contact point in
 * front of the body, and how far?" into a subtraction and a dot product
 * instead of a guess about where the camera happened to be standing.
 */
export function toBodyFrame(point: Vec, basis: BodyFrameBasis): BodyFrameCoordinates {
  const relative = subtract(point, basis.origin);
  return {
    lateral: dot(relative, basis.lateral),
    up: dot(relative, basis.up),
    forward: dot(relative, basis.forward),
  };
}

// ---------------------------------------------------------------------------
// Gravity-referenced helpers
// ---------------------------------------------------------------------------

/**
 * World "up", opposite gravity, in MediaPipe world-space axes (y DOWN).
 *
 * Some passing metrics — a passing platform's inclination, for instance — care
 * about the ball's flight relative to the *ground*, not the player's own lean.
 * A player can lean their whole trunk sideways and still present a flat
 * platform to the ball; measuring platform angle in the body frame would call
 * that a fault when it is not.
 *
 * IMPORTANT ASSUMPTION: this treats world -y as vertical, which is only true
 * when the recording device is held roughly level. A tablet propped up rolled
 * to one side tilts the whole world frame with it, and every angle computed
 * against `WORLD_UP` silently inherits that tilt as if the player were leaning.
 * This module does not detect or correct for a rolled camera — a caller that
 * cares (e.g. a capture-quality check) should warn the user separately rather
 * than trust these numbers blindly. See bodyFrame.test.ts for a test that
 * demonstrates the failure: rotating the scene about a *horizontal* axis (a
 * roll) changes `angleFromHorizontal`, exactly the situation this assumption
 * cannot see through.
 */
export const WORLD_UP: Vec3 = { x: 0, y: -1, z: 0 };

/**
 * Signed angle, in degrees, between `v` and the horizontal (world x/z) plane.
 * Positive means `v` points above horizontal (toward `WORLD_UP`), negative
 * means below. Complementary to `angleBetween` in vectorMath, which is always
 * unsigned and has no notion of "horizontal" at all.
 *
 * Subject to the same rolled-camera caveat as `WORLD_UP` above.
 *
 * @returns null for a degenerate (zero-length) vector.
 */
export function angleFromHorizontal(v: Vec): number | null {
  if (!isFiniteVec(v)) return null;
  const z = v.z ?? 0;
  const horizontalMagnitude = Math.hypot(v.x, z);
  const verticalComponent = -v.y; // world y is DOWN; flip so +ve means "up".
  if (horizontalMagnitude < EPSILON && Math.abs(verticalComponent) < EPSILON) return null;
  return radToDeg(Math.atan2(verticalComponent, horizontalMagnitude));
}
