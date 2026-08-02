/**
 * vectorMath.ts — pure, dependency-free vector physics helpers.
 *
 * Everything in this file is a total function of its inputs: no DOM, no state,
 * no MediaPipe types. That keeps it unit-testable and reusable by the mock-data
 * generator, the live inference pipeline and the tests alike.
 *
 * Coordinate conventions used throughout SpikePhysics:
 *   - Pixel space: x right, y DOWN (image convention, as MediaPipe reports it).
 *     Angles are unaffected by the flipped y; only *signed* vertical velocities
 *     care, and those are negated at the call site (see `verticalVelocity`).
 *   - A missing `z` is treated as 0, so the same functions serve 2D pixel-space
 *     work and 3D normalized/world-space work.
 */

/** A 2D or 3D point. `z` is optional and defaults to 0. */
export interface Vec {
  x: number;
  y: number;
  z?: number;
}

/** A fully specified 3D vector, as returned by every operation here. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Below this magnitude a vector is treated as degenerate (no direction). */
export const EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function radToDeg(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function degToRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------------------------------------------------------------------------
// Construction and validation
// ---------------------------------------------------------------------------

export function vec(x: number, y: number, z = 0): Vec3 {
  return { x, y, z };
}

/** Widens a 2D or 3D point to a full Vec3, defaulting a missing z to 0. */
export function toVec3(v: Vec): Vec3 {
  return { x: v.x, y: v.y, z: v.z ?? 0 };
}

/**
 * True when every component is a finite number. Pose landmarks routinely arrive
 * as NaN/undefined for occluded joints, so guard before every calculation.
 */
export function isFiniteVec(v: Vec | null | undefined): v is Vec {
  return (
    v != null &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    (v.z === undefined || Number.isFinite(v.z))
  );
}

// ---------------------------------------------------------------------------
// Core algebra
// ---------------------------------------------------------------------------

export function add(a: Vec, b: Vec): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: (a.z ?? 0) + (b.z ?? 0) };
}

/** a - b, i.e. the vector pointing from b to a. */
export function subtract(a: Vec, b: Vec): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
}

export function scale(v: Vec, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: (v.z ?? 0) * factor };
}

export function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
}

export function cross(a: Vec, b: Vec): Vec3 {
  const az = a.z ?? 0;
  const bz = b.z ?? 0;
  return {
    x: a.y * bz - az * b.y,
    y: az * b.x - a.x * bz,
    z: a.x * b.y - a.y * b.x,
  };
}

export function magnitude(v: Vec): number {
  return Math.sqrt(dot(v, v));
}

export function distance(a: Vec, b: Vec): number {
  return magnitude(subtract(a, b));
}

/** Unit vector, or null when the input is too short to have a direction. */
export function normalize(v: Vec): Vec3 | null {
  const len = magnitude(v);
  if (len < EPSILON) return null;
  return scale(v, 1 / len);
}

export function midpoint(a: Vec, b: Vec): Vec3 {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
  };
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

/**
 * Unsigned angle between two vectors, in degrees (0–180).
 *
 * The cosine is clamped to [-1, 1] before `acos`: floating-point error on
 * near-parallel vectors otherwise pushes the ratio to 1.0000000000000002 and
 * yields NaN, which is exactly the case that shows up at full elbow extension.
 *
 * @returns null when either vector is degenerate.
 */
export function angleBetween(u: Vec, v: Vec): number | null {
  if (!isFiniteVec(u) || !isFiniteVec(v)) return null;
  const denominator = magnitude(u) * magnitude(v);
  if (denominator < EPSILON) return null;
  return radToDeg(Math.acos(clamp(dot(u, v) / denominator, -1, 1)));
}

/**
 * Interior joint angle at `vertex`, formed by the rays vertex→a and vertex→b.
 *
 * This is the workhorse for every anatomical angle in the app:
 *   - Elbow flexion:      angleAt(elbow, shoulder, wrist)
 *   - Shoulder abduction: angleAt(hittingShoulder, oppositeShoulder, elbow)
 *   - Knee flexion:       angleAt(knee, hip, ankle)
 *
 * @returns degrees in [0, 180], or null if a landmark is missing/coincident.
 */
export function angleAt(vertex: Vec, a: Vec, b: Vec): number | null {
  if (!isFiniteVec(vertex) || !isFiniteVec(a) || !isFiniteVec(b)) return null;
  return angleBetween(subtract(a, vertex), subtract(b, vertex));
}

/**
 * Signed angle from u to v in the XY plane, in degrees (-180, 180].
 * Positive is counter-clockwise in a y-up frame — remember that pixel space is
 * y-down, so on screen a positive result reads as clockwise.
 */
export function signedAngle2D(u: Vec, v: Vec): number | null {
  if (!isFiniteVec(u) || !isFiniteVec(v)) return null;
  if (magnitude(u) < EPSILON || magnitude(v) < EPSILON) return null;
  return radToDeg(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y));
}

/** Scalar projection of `v` onto `onto` (length of v's shadow, signed). */
export function scalarProjection(v: Vec, onto: Vec): number | null {
  const len = magnitude(onto);
  if (len < EPSILON) return null;
  return dot(v, onto) / len;
}

// ---------------------------------------------------------------------------
// Kinematics
// ---------------------------------------------------------------------------

/**
 * Speed of a landmark between two consecutive samples.
 *
 * Implements §4C of the spec:
 *   V = |P_f - P_{f-1}| / dt * scaleFactor
 *
 * With `scaleFactor` in torso-lengths-per-pixel and `dtSeconds` in seconds, the
 * result is torso-lengths per second — a camera-distance-invariant unit.
 *
 * @returns null when either sample is unusable or dt is non-positive.
 */
export function speedBetween(
  previous: Vec,
  current: Vec,
  dtSeconds: number,
  scaleFactor = 1,
): number | null {
  if (!isFiniteVec(previous) || !isFiniteVec(current)) return null;
  if (!(dtSeconds > 0) || !Number.isFinite(scaleFactor)) return null;
  return (distance(current, previous) / dtSeconds) * scaleFactor;
}

/**
 * Velocity vector between two samples, scaled to physical units.
 * The y component is negated so that positive y means UP, matching the
 * convention used by the existing Python analyzers.
 */
export function velocityBetween(
  previous: Vec,
  current: Vec,
  dtSeconds: number,
  scaleFactor = 1,
): Vec3 | null {
  if (!isFiniteVec(previous) || !isFiniteVec(current)) return null;
  if (!(dtSeconds > 0)) return null;
  const delta = subtract(current, previous);
  return {
    x: (delta.x / dtSeconds) * scaleFactor,
    y: (-delta.y / dtSeconds) * scaleFactor,
    z: (delta.z / dtSeconds) * scaleFactor,
  };
}

/**
 * First derivative of a scalar series using central differences in the interior
 * and one-sided differences at the ends. Gaps (null) propagate to any sample
 * that depends on them rather than being silently interpolated.
 *
 * @param values   e.g. elbow angle per frame, in degrees
 * @param dtSeconds sample interval
 * @returns series of the same length, in units-per-second
 */
export function derivative(
  values: readonly (number | null)[],
  dtSeconds: number,
): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < 2 || !(dtSeconds > 0)) return out;

  for (let i = 0; i < n; i += 1) {
    const prev = i > 0 ? values[i - 1] : undefined;
    const next = i < n - 1 ? values[i + 1] : undefined;
    const here = values[i];

    if (prev != null && next != null) {
      out[i] = (next - prev) / (2 * dtSeconds);
    } else if (next != null && here != null) {
      out[i] = (next - here) / dtSeconds;
    } else if (prev != null && here != null) {
      out[i] = (here - prev) / dtSeconds;
    }
  }
  return out;
}

/**
 * Index of the largest finite value in a series, ignoring nulls.
 * @returns -1 when the series contains no usable sample.
 */
export function argMax(values: readonly (number | null)[]): number {
  let bestIndex = -1;
  let best = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value == null || !Number.isFinite(value)) continue;
    if (value > best) {
      best = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}

/** Index of the smallest finite value in a series, ignoring nulls. */
export function argMin(values: readonly (number | null)[]): number {
  let bestIndex = -1;
  let best = Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value == null || !Number.isFinite(value)) continue;
    if (value < best) {
      best = value;
      bestIndex = i;
    }
  }
  return bestIndex;
}
