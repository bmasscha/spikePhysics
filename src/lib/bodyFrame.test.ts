import { describe, expect, it } from "vitest";
import {
  angleFromHorizontal,
  bodyFrameAt,
  getWorldLandmark,
  toBodyFrame,
  WORLD_UP,
  type BodyFrameBasis,
} from "./bodyFrame";
import { angleBetween, degToRad, dot, magnitude, subtract, type Vec3 } from "./vectorMath";
import { LM } from "./landmarks";
import type { PoseFrame, WorldLandmark } from "../types/pose";

/** Builds a world landmark at a given metre position, fully visible by default. */
function wl(x: number, y: number, z: number, visibility = 1): WorldLandmark {
  return { x, y, z, visibility };
}

/**
 * Builds a PoseFrame carrying only `worldLandmarks`, sized to 33 entries like a
 * real MediaPipe frame. Indices not present in `points` are left untracked
 * (visibility 0), matching how an occluded landmark actually arrives.
 */
function frameFromWorld(points: Partial<Record<number, WorldLandmark>>): PoseFrame {
  const worldLandmarks: WorldLandmark[] = Array.from(
    { length: 33 },
    (_, i) => points[i] ?? wl(0, 0, 0, 0),
  );
  return { index: 0, timestampMs: 0, landmarks: [], worldLandmarks };
}

/** A plausible standing trunk, hips at the origin, shoulders 0.5m "up" (i.e. -y). */
const UPRIGHT_TRUNK: Partial<Record<number, WorldLandmark>> = {
  [LM.LEFT_HIP]: wl(0.1, 0, 0),
  [LM.RIGHT_HIP]: wl(-0.1, 0, 0),
  [LM.LEFT_SHOULDER]: wl(0.12, -0.5, 0),
  [LM.RIGHT_SHOULDER]: wl(-0.12, -0.5, 0),
};

/** Rotates a point about the world vertical axis (y), by `degrees`, about the origin. */
function rotateAroundY(p: Vec3, degrees: number): Vec3 {
  const r = degToRad(degrees);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: p.x * cos + p.z * sin, y: p.y, z: -p.x * sin + p.z * cos };
}

/** Rotates a point about a horizontal axis (x), by `degrees` — simulates a rolled camera. */
function rotateAroundX(p: Vec3, degrees: number): Vec3 {
  const r = degToRad(degrees);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: p.x, y: p.y * cos - p.z * sin, z: p.y * sin + p.z * cos };
}

function rotateFrameY(points: Partial<Record<number, WorldLandmark>>, degrees: number) {
  const out: Partial<Record<number, WorldLandmark>> = {};
  for (const [key, lm] of Object.entries(points)) {
    if (!lm) continue;
    const rotated = rotateAroundY(lm, degrees);
    out[Number(key)] = wl(rotated.x, rotated.y, rotated.z, lm.visibility);
  }
  return out;
}

// ---------------------------------------------------------------------------
// getWorldLandmark
// ---------------------------------------------------------------------------

describe("getWorldLandmark", () => {
  it("returns the landmark when present and confidently visible", () => {
    const frame = frameFromWorld({ [LM.NOSE]: wl(0.01, -0.6, 0.02, 0.9) });
    expect(getWorldLandmark(frame, LM.NOSE)).toEqual(wl(0.01, -0.6, 0.02, 0.9));
  });

  it("returns null when the frame is undefined", () => {
    expect(getWorldLandmark(undefined, LM.NOSE)).toBeNull();
  });

  it("returns null when worldLandmarks is absent (e.g. a hand-built fixture)", () => {
    const frame: PoseFrame = { index: 0, timestampMs: 0, landmarks: [] };
    expect(getWorldLandmark(frame, LM.NOSE)).toBeNull();
  });

  it("returns null below the visibility threshold", () => {
    const frame = frameFromWorld({ [LM.NOSE]: wl(0, 0, 0, 0.2) });
    expect(getWorldLandmark(frame, LM.NOSE)).toBeNull();
  });

  it("returns null for non-finite coordinates", () => {
    const frame = frameFromWorld({ [LM.NOSE]: wl(NaN, 0, 0, 1) });
    expect(getWorldLandmark(frame, LM.NOSE)).toBeNull();
  });

  it("honors a custom minVisibility", () => {
    const frame = frameFromWorld({ [LM.NOSE]: wl(0, 0, 0, 0.6) });
    expect(getWorldLandmark(frame, LM.NOSE, 0.5)).not.toBeNull();
    expect(getWorldLandmark(frame, LM.NOSE, 0.7)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bodyFrameAt — null handling
// ---------------------------------------------------------------------------

describe("bodyFrameAt — null handling", () => {
  it("returns null when the frame is undefined", () => {
    expect(bodyFrameAt(undefined)).toBeNull();
  });

  it("returns null when worldLandmarks were never populated", () => {
    const frame: PoseFrame = { index: 0, timestampMs: 0, landmarks: [] };
    expect(bodyFrameAt(frame)).toBeNull();
  });

  it("returns null when any one trunk landmark is missing", () => {
    const { [LM.RIGHT_HIP]: _drop, ...rest } = UPRIGHT_TRUNK;
    expect(bodyFrameAt(frameFromWorld(rest))).toBeNull();
  });

  it("returns null when a trunk landmark is below the visibility threshold", () => {
    const lowVis = {
      ...UPRIGHT_TRUNK,
      [LM.RIGHT_HIP]: wl(-0.1, 0, 0, 0.1),
    };
    expect(bodyFrameAt(frameFromWorld(lowVis))).toBeNull();
  });

  it("returns null for a degenerate trunk (shoulders coincident with hips)", () => {
    const degenerate: Partial<Record<number, WorldLandmark>> = {
      [LM.LEFT_HIP]: wl(0.1, 0, 0),
      [LM.RIGHT_HIP]: wl(-0.1, 0, 0),
      [LM.LEFT_SHOULDER]: wl(0.1, 0, 0),
      [LM.RIGHT_SHOULDER]: wl(-0.1, 0, 0),
    };
    expect(bodyFrameAt(frameFromWorld(degenerate))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// bodyFrameAt — orthonormality and handedness
// ---------------------------------------------------------------------------

describe("bodyFrameAt — orthonormality", () => {
  it("produces three unit-length, mutually orthogonal axes", () => {
    const basis = bodyFrameAt(frameFromWorld(UPRIGHT_TRUNK));
    expect(basis).not.toBeNull();
    const { up, lateral, forward } = basis as BodyFrameBasis;

    expect(magnitude(up)).toBeCloseTo(1, 10);
    expect(magnitude(lateral)).toBeCloseTo(1, 10);
    expect(magnitude(forward)).toBeCloseTo(1, 10);

    expect(dot(up, lateral)).toBeCloseTo(0, 10);
    expect(dot(up, forward)).toBeCloseTo(0, 10);
    expect(dot(lateral, forward)).toBeCloseTo(0, 10);
  });

  it("still orthogonalizes when the hip line is not perfectly square to the spine", () => {
    // Shoulders offset diagonally, so the raw hip line is not exactly
    // perpendicular to hip->shoulder — Gram-Schmidt must correct for this.
    const skewed: Partial<Record<number, WorldLandmark>> = {
      [LM.LEFT_HIP]: wl(0.1, 0, 0),
      [LM.RIGHT_HIP]: wl(-0.1, 0, 0),
      [LM.LEFT_SHOULDER]: wl(0.3, -0.5, 0.1),
      [LM.RIGHT_SHOULDER]: wl(0.1, -0.5, 0.1),
    };
    const basis = bodyFrameAt(frameFromWorld(skewed));
    expect(basis).not.toBeNull();
    const { up, lateral, forward } = basis as BodyFrameBasis;
    expect(dot(up, lateral)).toBeCloseTo(0, 10);
    expect(dot(up, forward)).toBeCloseTo(0, 10);
    expect(dot(lateral, forward)).toBeCloseTo(0, 10);
  });

  it("puts 'up' toward the head, i.e. in the negative-y direction", () => {
    const basis = bodyFrameAt(frameFromWorld(UPRIGHT_TRUNK)) as BodyFrameBasis;
    expect(basis.up.y).toBeLessThan(0);
  });

  it("resolves the origin to the hip midpoint", () => {
    const basis = bodyFrameAt(frameFromWorld(UPRIGHT_TRUNK)) as BodyFrameBasis;
    expect(basis.origin).toEqual({ x: 0, y: 0, z: 0 });
  });

  // The handedness trap. MediaPipe's z grows AWAY from the camera — "the
  // smaller the value the closer the landmark is to the camera" — so a player
  // facing the lens faces NEGATIVE z. These two tests are the guardrail: an
  // inverted `forward` would quietly turn "contact in front of the body" into
  // "behind" while every number built on it still looked plausible.
  it("gives 'forward' a negative z component for a player facing the camera", () => {
    // Player faces the camera directly: their anatomical right hip/shoulder
    // (RIGHT_*) sit on the image's LEFT (negative world x) because two people
    // facing each other are mirror images of one another.
    const facingCamera: Partial<Record<number, WorldLandmark>> = {
      [LM.LEFT_HIP]: wl(0.1, 0, 0),
      [LM.RIGHT_HIP]: wl(-0.1, 0, 0),
      [LM.LEFT_SHOULDER]: wl(0.1, -0.5, 0),
      [LM.RIGHT_SHOULDER]: wl(-0.1, -0.5, 0),
    };
    const basis = bodyFrameAt(frameFromWorld(facingCamera)) as BodyFrameBasis;
    expect(basis.forward.z).toBeLessThan(0);
  });

  it("gives 'forward' a positive z component for a player with their back to the camera", () => {
    const backToCamera: Partial<Record<number, WorldLandmark>> = {
      [LM.LEFT_HIP]: wl(-0.1, 0, 0),
      [LM.RIGHT_HIP]: wl(0.1, 0, 0),
      [LM.LEFT_SHOULDER]: wl(-0.1, -0.5, 0),
      [LM.RIGHT_SHOULDER]: wl(0.1, -0.5, 0),
    };
    const basis = bodyFrameAt(frameFromWorld(backToCamera)) as BodyFrameBasis;
    expect(basis.forward.z).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// toBodyFrame
// ---------------------------------------------------------------------------

describe("toBodyFrame", () => {
  it("resolves the origin itself to {0,0,0}", () => {
    const basis = bodyFrameAt(frameFromWorld(UPRIGHT_TRUNK)) as BodyFrameBasis;
    const coords = toBodyFrame(basis.origin, basis);
    // Compared numerically rather than with toEqual: a dot product against an
    // axis with a negative component yields -0, and toEqual uses Object.is, for
    // which -0 and 0 differ. They do not differ in any way that matters here.
    expect(coords.lateral).toBeCloseTo(0, 12);
    expect(coords.up).toBeCloseTo(0, 12);
    expect(coords.forward).toBeCloseTo(0, 12);
  });

  it("reads a point one metre along 'up' as {0,1,0}", () => {
    const basis = bodyFrameAt(frameFromWorld(UPRIGHT_TRUNK)) as BodyFrameBasis;
    const point = { x: basis.origin.x + basis.up.x, y: basis.origin.y + basis.up.y, z: basis.origin.z + basis.up.z };
    const coords = toBodyFrame(point, basis);
    expect(coords.up).toBeCloseTo(1, 9);
    expect(coords.lateral).toBeCloseTo(0, 9);
    expect(coords.forward).toBeCloseTo(0, 9);
  });

  it("splits an off-axis point into all three components correctly", () => {
    // A simple axis-aligned basis is easier to reason about by hand than the
    // derived one: lateral=+x, up=+y, forward=+z.
    const basis: BodyFrameBasis = {
      origin: { x: 1, y: 2, z: 3 },
      lateral: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      forward: { x: 0, y: 0, z: 1 },
    };
    const point = { x: 1 + 5, y: 2 + 7, z: 3 + 11 };
    expect(toBodyFrame(point, basis)).toEqual({ lateral: 5, up: 7, forward: 11 });
  });
});

// ---------------------------------------------------------------------------
// The test that matters most: camera-azimuth invariance.
//
// This is the whole justification for the module. Serve-receive is filmed at
// "about 45 degrees" — never exactly, and never the same angle twice. If the
// body frame is doing its job, re-shooting the identical player pose from a
// different horizontal camera angle (a rotation about the vertical axis) must
// not move a single body-frame number: not the basis vectors' relationship to
// the body, not a point re-expressed in the frame, not a body-relative angle.
// Camera placement should be invisible to every measurement this module
// produces. Only floating-point rounding may differ, hence the tight
// tolerance (1e-9) rather than a loose one.
// ---------------------------------------------------------------------------

describe("camera-azimuth invariance", () => {
  const WRIST: WorldLandmark = wl(0.35, -0.3, 0.4);

  it("keeps body-frame coordinates unchanged when the whole scene is rotated about the vertical axis", () => {
    const original = { ...UPRIGHT_TRUNK, [LM.RIGHT_WRIST]: WRIST };
    const basisBefore = bodyFrameAt(frameFromWorld(original)) as BodyFrameBasis;
    const wristBefore = toBodyFrame(WRIST, basisBefore);

    for (const degrees of [15, 45, 90, 137, -45]) {
      const rotatedTrunk = rotateFrameY(UPRIGHT_TRUNK, degrees);
      const rotatedWrist = rotateAroundY(WRIST, degrees);
      const rotated = { ...rotatedTrunk, [LM.RIGHT_WRIST]: wl(rotatedWrist.x, rotatedWrist.y, rotatedWrist.z) };

      const basisAfter = bodyFrameAt(frameFromWorld(rotated)) as BodyFrameBasis;
      expect(basisAfter).not.toBeNull();
      const wristAfter = toBodyFrame(rotatedWrist, basisAfter);

      expect(wristAfter.lateral).toBeCloseTo(wristBefore.lateral, 9);
      expect(wristAfter.up).toBeCloseTo(wristBefore.up, 9);
      expect(wristAfter.forward).toBeCloseTo(wristBefore.forward, 9);
    }
  });

  it("keeps a body-relative angle unchanged under the same rotation", () => {
    // A body-relative angle: how far the wrist sits off the "forward" axis,
    // measured at the hip origin. This is the shape of measurement a
    // serve-receive metric actually needs (e.g. "is the platform in front of
    // the body, and by how much").
    const angleFor = (points: Partial<Record<number, WorldLandmark>>, wrist: Vec3) => {
      const basis = bodyFrameAt(frameFromWorld(points)) as BodyFrameBasis;
      return angleBetween(basis.forward, subtract(wrist, basis.origin));
    };

    const baseline = angleFor(UPRIGHT_TRUNK, WRIST);
    expect(baseline).not.toBeNull();

    for (const degrees of [15, 45, 90, 137, -45]) {
      const rotatedTrunk = rotateFrameY(UPRIGHT_TRUNK, degrees);
      const rotatedWrist = rotateAroundY(WRIST, degrees);
      const angle = angleFor(rotatedTrunk, rotatedWrist);
      expect(angle).toBeCloseTo(baseline as number, 7);
    }
  });
});

// ---------------------------------------------------------------------------
// Gravity-referenced helpers
// ---------------------------------------------------------------------------

describe("WORLD_UP", () => {
  it("points in -y, opposite the y-DOWN convention", () => {
    expect(WORLD_UP).toEqual({ x: 0, y: -1, z: 0 });
  });
});

describe("angleFromHorizontal", () => {
  it("reads 0 for a purely horizontal vector", () => {
    expect(angleFromHorizontal({ x: 1, y: 0, z: 0 })).toBeCloseTo(0, 10);
    expect(angleFromHorizontal({ x: 0, y: 0, z: 1 })).toBeCloseTo(0, 10);
  });

  it("reads +90 for a vector pointing straight up (world -y)", () => {
    expect(angleFromHorizontal({ x: 0, y: -1, z: 0 })).toBeCloseTo(90, 10);
  });

  it("reads -90 for a vector pointing straight down (world +y)", () => {
    expect(angleFromHorizontal({ x: 0, y: 1, z: 0 })).toBeCloseTo(-90, 10);
  });

  it("reads +45 for a vector angled evenly between horizontal and up", () => {
    expect(angleFromHorizontal({ x: 1, y: -1, z: 0 })).toBeCloseTo(45, 10);
  });

  it("returns null for a degenerate (zero-length) vector", () => {
    expect(angleFromHorizontal({ x: 0, y: 0, z: 0 })).toBeNull();
  });

  // Proves the documented assumption is a real, testable assumption and not
  // an accident: a rotation about a HORIZONTAL axis (x) is exactly what a
  // rolled/tilted tablet does to the world frame, and unlike the vertical-axis
  // (azimuth) rotation above, it DOES change the gravity-referenced angle —
  // because a rolled camera really does make WORLD_UP wrong. This is the
  // failure mode documented on WORLD_UP: nothing here corrects for it.
  it("changes under a rotation about a horizontal axis (a rolled camera), unlike the azimuth case", () => {
    const v = { x: 0, y: -1, z: 0 }; // straight "up" in the (unrolled) world frame
    const before = angleFromHorizontal(v);
    const rolled = rotateAroundX(v, 20);
    const after = angleFromHorizontal(rolled);
    expect(before).toBeCloseTo(90, 10);
    expect(after).not.toBeNull();
    expect(Math.abs((after as number) - (before as number))).toBeGreaterThan(15);
  });
});
