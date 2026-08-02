import { describe, expect, it } from "vitest";
import {
  angleAt,
  angleBetween,
  argMax,
  argMin,
  cross,
  derivative,
  distance,
  dot,
  isFiniteVec,
  magnitude,
  midpoint,
  normalize,
  scalarProjection,
  signedAngle2D,
  speedBetween,
  subtract,
  vec,
  velocityBetween,
} from "./vectorMath";

describe("basic algebra", () => {
  it("subtracts, treating a missing z as 0", () => {
    expect(subtract({ x: 3, y: 4 }, { x: 1, y: 1 })).toEqual({ x: 2, y: 3, z: 0 });
    expect(subtract(vec(3, 4, 5), vec(1, 1, 1))).toEqual({ x: 2, y: 3, z: 4 });
  });

  it("computes dot, cross and magnitude", () => {
    expect(dot(vec(1, 2, 3), vec(4, -5, 6))).toBe(12);
    expect(cross(vec(1, 0, 0), vec(0, 1, 0))).toEqual({ x: 0, y: 0, z: 1 });
    expect(magnitude(vec(3, 4))).toBe(5);
  });

  it("measures distance and midpoint in 2D pixel space", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 0 }, { x: 4, y: 8 })).toEqual({ x: 2, y: 4, z: 0 });
  });

  it("returns null when normalizing a degenerate vector", () => {
    expect(normalize(vec(0, 0, 0))).toBeNull();
    expect(normalize(vec(0, 5))).toEqual({ x: 0, y: 1, z: 0 });
  });

  it("rejects non-finite vectors", () => {
    expect(isFiniteVec({ x: NaN, y: 1 })).toBe(false);
    expect(isFiniteVec(null)).toBe(false);
    expect(isFiniteVec({ x: 1, y: 2 })).toBe(true);
  });
});

describe("angleBetween", () => {
  it("measures the angle between two vectors in degrees", () => {
    expect(angleBetween(vec(1, 0), vec(0, 1))).toBeCloseTo(90, 10);
    expect(angleBetween(vec(1, 0), vec(-1, 0))).toBeCloseTo(180, 10);
    expect(angleBetween(vec(1, 0), vec(1, 1))).toBeCloseTo(45, 10);
  });

  it("clamps the cosine so parallel vectors never produce NaN", () => {
    // Reproduces the full-extension case: dot/(|u||v|) drifts just past 1.
    const u = vec(0.1 + 0.2, 0.3, 0);
    const v = vec(0.30000000000000004, 0.3, 0);
    const angle = angleBetween(u, v);
    expect(angle).not.toBeNull();
    expect(Number.isNaN(angle!)).toBe(false);
    expect(angle!).toBeGreaterThanOrEqual(0);
  });

  it("returns null for a zero-length vector", () => {
    expect(angleBetween(vec(0, 0), vec(1, 1))).toBeNull();
  });
});

describe("angleAt (joint angles)", () => {
  it("reports 90° for a right-angled joint", () => {
    // elbow at origin, shoulder straight up, wrist straight right
    expect(angleAt({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBeCloseTo(90, 10);
  });

  it("reports 180° for a fully extended limb", () => {
    const angle = angleAt({ x: 0, y: 0 }, { x: -5, y: 0 }, { x: 5, y: 0 });
    expect(angle).toBeCloseTo(180, 10);
  });

  it("is unaffected by whether y points up or down", () => {
    const up = angleAt({ x: 0, y: 0 }, { x: 3, y: 4 }, { x: -4, y: 3 });
    const down = angleAt({ x: 0, y: 0 }, { x: 3, y: -4 }, { x: -4, y: -3 });
    expect(up).toBeCloseTo(down!, 10);
  });

  it("returns null when a landmark is missing or coincident", () => {
    expect(angleAt({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
    expect(angleAt({ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 })).toBeNull();
  });

  it("computes shoulder abduction from the spec's landmark triple", () => {
    // Shoulder line points left, upper arm points up-and-left => 45° above the line.
    const shoulder = { x: 100, y: 100 };
    const oppositeShoulder = { x: 60, y: 100 };
    const elbow = { x: 60, y: 60 };
    expect(angleAt(shoulder, oppositeShoulder, elbow)).toBeCloseTo(45, 10);
  });
});

describe("signedAngle2D and projection", () => {
  it("signs the rotation direction", () => {
    expect(signedAngle2D(vec(1, 0), vec(0, 1))).toBeCloseTo(90, 10);
    expect(signedAngle2D(vec(0, 1), vec(1, 0))).toBeCloseTo(-90, 10);
  });

  it("projects one vector onto another", () => {
    expect(scalarProjection(vec(3, 4), vec(1, 0))).toBeCloseTo(3, 10);
    expect(scalarProjection(vec(3, 4), vec(0, 0))).toBeNull();
  });
});

describe("kinematics", () => {
  it("scales speed into torso-lengths per second", () => {
    // 30 px in 1/30 s = 900 px/s; a 150 px torso makes that 6 torso-lengths/s.
    const speed = speedBetween({ x: 0, y: 0 }, { x: 30, y: 0 }, 1 / 30, 1 / 150);
    expect(speed).toBeCloseTo(6, 10);
  });

  it("guards against a non-positive time step", () => {
    expect(speedBetween({ x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toBeNull();
  });

  it("negates y so positive velocity means upward on screen", () => {
    // pixelY decreasing = moving up
    const v = velocityBetween({ x: 0, y: 100 }, { x: 0, y: 40 }, 0.5);
    expect(v!.y).toBeCloseTo(120, 10);
  });

  it("differentiates a linear series to a constant slope", () => {
    const d = derivative([0, 2, 4, 6, 8], 0.5);
    expect(d).toEqual([4, 4, 4, 4, 4]);
  });

  it("propagates gaps instead of interpolating across them", () => {
    const d = derivative([0, null, 4], 1);
    expect(d[0]).toBeNull();
    expect(d[1]).toBeCloseTo(2, 10); // central difference spans the gap
    expect(d[2]).toBeNull();
  });

  it("finds peak frames while ignoring untracked samples", () => {
    expect(argMax([1, null, 9, 3])).toBe(2);
    expect(argMin([1, null, 9, 3])).toBe(0);
    expect(argMax([null, null])).toBe(-1);
  });
});
