import { describe, expect, it } from "vitest";
import { generateMockPass, type MockPassOptions } from "./mockPass";
import { LM, spatialPoint } from "./landmarks";
import { angleAt, angleBetween, distance, midpoint, subtract } from "./vectorMath";
import { angleFromHorizontal, bodyFrameAt, toBodyFrame, type BodyFrameBasis } from "./bodyFrame";

// MediaPipe indices for heel/foot-index. Not named in landmarks.ts (LM) — see
// mockPass.ts's own comment on LEFT_HEEL/RIGHT_HEEL/LEFT_FOOT_INDEX/
// RIGHT_FOOT_INDEX for why they are referenced by raw index here too.
const LEFT_HEEL = 29;
const RIGHT_HEEL = 30;
const LEFT_FOOT_INDEX = 31;
const RIGHT_FOOT_INDEX = 32;

/** Contact frame index, computed the same way generateMockPass computes it internally. */
function contactIndexFor(o: MockPassOptions): number {
  const fps = o.fps ?? 60;
  const durationSeconds = o.durationSeconds ?? 1.6;
  const contactAtFraction = o.contactAtFraction ?? 0.6;
  const frameCount = Math.max(8, Math.round(fps * durationSeconds));
  return Math.round(contactAtFraction * (frameCount - 1));
}

function worldElbowAngle(frame: { worldLandmarks?: { x: number; y: number; z: number }[] }, side: "LEFT" | "RIGHT") {
  const w = frame.worldLandmarks!;
  const shoulder = w[side === "LEFT" ? LM.LEFT_SHOULDER : LM.RIGHT_SHOULDER]!;
  const elbow = w[side === "LEFT" ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW]!;
  const wrist = w[side === "LEFT" ? LM.LEFT_WRIST : LM.RIGHT_WRIST]!;
  return angleAt(elbow, shoulder, wrist);
}

function worldKneeAngle(frame: { worldLandmarks?: { x: number; y: number; z: number }[] }, side: "LEFT" | "RIGHT") {
  const w = frame.worldLandmarks!;
  const hip = w[side === "LEFT" ? LM.LEFT_HIP : LM.RIGHT_HIP]!;
  const knee = w[side === "LEFT" ? LM.LEFT_KNEE : LM.RIGHT_KNEE]!;
  const ankle = w[side === "LEFT" ? LM.LEFT_ANKLE : LM.RIGHT_ANKLE]!;
  return angleAt(knee, hip, ankle);
}

function worldPlatformInclination(
  frame: { worldLandmarks?: { x: number; y: number; z: number }[] },
  side: "LEFT" | "RIGHT",
) {
  const w = frame.worldLandmarks!;
  const elbow = w[side === "LEFT" ? LM.LEFT_ELBOW : LM.RIGHT_ELBOW]!;
  const wrist = w[side === "LEFT" ? LM.LEFT_WRIST : LM.RIGHT_WRIST]!;
  return angleFromHorizontal(subtract(wrist, elbow));
}

// ---------------------------------------------------------------------------
// Contact-frame recoverability
//
// Tolerance: ~1cm of jitter (the default noiseMeters) on a ~0.25-0.42m bone,
// applied independently to both endpoints of the angle, perturbs a measured
// angle by roughly 2*noiseMeters/boneLength radians in the worst case (a
// perpendicular displacement at each end, over the shorter lever arm in play).
// For the forearm (0.25m) that is 2*0.01/0.25 ≈ 0.08 rad ≈ 4.6°; the knee's
// shorter arm (thigh/shank ≈ 0.42m) is a little better. 8° gives comfortable
// headroom over that estimate without being loose enough to pass a broken
// generator.
// ---------------------------------------------------------------------------
describe("generateMockPass — contact-frame recoverability (world landmarks)", () => {
  const CASES: MockPassOptions[] = [
    {}, // defaults
    { elbowAngleAtContact: 150, kneeAngleAtContact: 120, platformInclinationAtContact: 40 },
    { elbowAngleAtContact: 179, kneeAngleAtContact: 170, platformInclinationAtContact: 5 },
  ];

  for (const [i, base] of CASES.entries()) {
    it(`case ${i}: exact at zero noise`, () => {
      const o: MockPassOptions = { ...base, noiseMeters: 0 };
      const seq = generateMockPass(o);
      const frame = seq.frames[contactIndexFor(o)]!;

      expect(worldElbowAngle(frame, "LEFT")).toBeCloseTo(o.elbowAngleAtContact ?? 175, 6);
      expect(worldElbowAngle(frame, "RIGHT")).toBeCloseTo(o.elbowAngleAtContact ?? 175, 6);
      expect(worldKneeAngle(frame, "LEFT")).toBeCloseTo(o.kneeAngleAtContact ?? 145, 6);
      expect(worldKneeAngle(frame, "RIGHT")).toBeCloseTo(o.kneeAngleAtContact ?? 145, 6);
      expect(worldPlatformInclination(frame, "LEFT")).toBeCloseTo(o.platformInclinationAtContact ?? 25, 6);
      expect(worldPlatformInclination(frame, "RIGHT")).toBeCloseTo(o.platformInclinationAtContact ?? 25, 6);
    });

    it(`case ${i}: within 8 degrees at default noise`, () => {
      const seq = generateMockPass(base);
      const frame = seq.frames[contactIndexFor(base)]!;

      expect(Math.abs(worldElbowAngle(frame, "LEFT")! - (base.elbowAngleAtContact ?? 175))).toBeLessThan(8);
      expect(Math.abs(worldKneeAngle(frame, "LEFT")! - (base.kneeAngleAtContact ?? 145))).toBeLessThan(8);
      expect(
        Math.abs(worldPlatformInclination(frame, "LEFT")! - (base.platformInclinationAtContact ?? 25)),
      ).toBeLessThan(8);
    });
  }
});

// ---------------------------------------------------------------------------
// Azimuth invariance — the fixture's most important property.
//
// The camera never sees the same 45° twice; a body-relative measurement must
// not depend on where the tripod happened to be. Generated at noiseMeters: 0
// so the comparison is exact (the rotation is the only difference between
// clips), mirroring bodyFrame.test.ts's own azimuth-invariance tolerance.
// ---------------------------------------------------------------------------
describe("generateMockPass — camera-azimuth invariance", () => {
  const AZIMUTHS = [0, 30, 45, 60];
  const base: MockPassOptions = {
    noiseMeters: 0,
    elbowAngleAtContact: 160,
    kneeAngleAtContact: 130,
    platformInclinationAtContact: 35,
    handSeparationMeters: 0.1,
  };

  it("keeps elbow, knee and platform-inclination readings identical across azimuths", () => {
    const readings = AZIMUTHS.map((cameraAzimuthDegrees) => {
      const o = { ...base, cameraAzimuthDegrees };
      const frame = generateMockPass(o).frames[contactIndexFor(o)]!;
      return {
        elbow: worldElbowAngle(frame, "LEFT")!,
        knee: worldKneeAngle(frame, "LEFT")!,
        platform: worldPlatformInclination(frame, "LEFT")!,
      };
    });

    const reference = readings[0]!;
    for (const reading of readings.slice(1)) {
      expect(reading.elbow).toBeCloseTo(reference.elbow, 6);
      expect(reading.knee).toBeCloseTo(reference.knee, 6);
      expect(reading.platform).toBeCloseTo(reference.platform, 6);
    }
  });

  it("keeps bodyFrame.ts's body-relative coordinates identical across azimuths", () => {
    // Exercises bodyFrame.ts directly against this fixture, proving the
    // fixture is exactly the shape of thing that module's own invariance test
    // assumes: a well-formed, non-degenerate trunk it can build a basis from.
    const readings = AZIMUTHS.map((cameraAzimuthDegrees) => {
      const o = { ...base, cameraAzimuthDegrees };
      const frame = generateMockPass(o).frames[contactIndexFor(o)]!;
      const basis = bodyFrameAt(frame) as BodyFrameBasis;
      expect(basis).not.toBeNull();
      const wrist = frame.worldLandmarks![LM.LEFT_WRIST]!;
      return toBodyFrame(wrist, basis);
    });

    const reference = readings[0]!;
    for (const reading of readings.slice(1)) {
      expect(reading.lateral).toBeCloseTo(reference.lateral, 6);
      expect(reading.up).toBeCloseTo(reference.up, 6);
      expect(reading.forward).toBeCloseTo(reference.forward, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Hip midpoint at the world origin
// ---------------------------------------------------------------------------
describe("generateMockPass — hip midpoint", () => {
  it("sits at the world origin every frame, even with default noise", () => {
    // Exact by construction (re-centred on the noisy hip midpoint itself —
    // see mockPass.ts's comment above the `hipMid` computation), so this
    // should hold to floating-point precision, not merely approximately.
    const sequence = generateMockPass();
    for (const frame of sequence.frames) {
      const hipMid = midpoint(frame.worldLandmarks![LM.LEFT_HIP]!, frame.worldLandmarks![LM.RIGHT_HIP]!);
      expect(hipMid.x).toBeCloseTo(0, 9);
      expect(hipMid.y).toBeCloseTo(0, 9);
      expect(hipMid.z).toBeCloseTo(0, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// Pixel / world geometric consistency
// ---------------------------------------------------------------------------
describe("generateMockPass — pixel/world consistency", () => {
  it("agrees on the elbow angle whether computed from pixel or world landmarks", () => {
    // The map from world to pixel space is a pure similarity transform (one
    // isotropic metres->pixels factor for x, y AND z, plus a screen-space
    // translation) — see PIXELS_PER_METER's comment in mockPass.ts — which
    // preserves every angle exactly.
    const sequence = generateMockPass({ noiseMeters: 0.01, seed: 7 });
    for (let i = 0; i < sequence.frames.length; i += 10) {
      const frame = sequence.frames[i]!;
      const pixelAngle = angleAt(
        spatialPoint(frame.landmarks[LM.RIGHT_ELBOW]!),
        spatialPoint(frame.landmarks[LM.RIGHT_SHOULDER]!),
        spatialPoint(frame.landmarks[LM.RIGHT_WRIST]!),
      );
      const worldAngle = angleAt(
        frame.worldLandmarks![LM.RIGHT_ELBOW]!,
        frame.worldLandmarks![LM.RIGHT_SHOULDER]!,
        frame.worldLandmarks![LM.RIGHT_WRIST]!,
      );
      expect(pixelAngle).not.toBeNull();
      expect(worldAngle).not.toBeNull();
      expect(pixelAngle!).toBeCloseTo(worldAngle!, 6);
    }
  });
});

// ---------------------------------------------------------------------------
// Knobs that must show up as motion, not just a value at contact
// ---------------------------------------------------------------------------
describe("generateMockPass — platformSwingDegreesPerSecond", () => {
  it("is recoverable as the platform's angular speed through the contact frame", () => {
    for (const rate of [0, 20, 300]) {
      const o: MockPassOptions = { platformSwingDegreesPerSecond: rate, noiseMeters: 0 };
      const seq = generateMockPass(o);
      const c = contactIndexFor(o);
      const before = worldPlatformInclination(seq.frames[c - 1]!, "LEFT")!;
      const after = worldPlatformInclination(seq.frames[c + 1]!, "LEFT")!;
      const dt = 2 / (o.fps ?? 60);
      const measuredRate = (after - before) / dt;
      // Exact (before noise): the swing is built as a straight line through
      // the whole window around contact, so a central difference recovers
      // its slope with no discretization error.
      expect(measuredRate).toBeCloseTo(rate, 3);
    }
  });

  it("leaves the platform still (near-zero measured rate) at the default quiet-platform setting", () => {
    const seq = generateMockPass({ noiseMeters: 0 });
    const c = contactIndexFor({});
    const before = worldPlatformInclination(seq.frames[c - 1]!, "LEFT")!;
    const after = worldPlatformInclination(seq.frames[c + 1]!, "LEFT")!;
    // Default platformSwingDegreesPerSecond is 20, not 0, so this checks the
    // rate is *small*, not exactly zero.
    expect(Math.abs(after - before)).toBeLessThan(2);
  });
});

describe("generateMockPass — footSpeedAtContact", () => {
  it("is recoverable as the ankle's speed through the contact frame", () => {
    for (const speed of [0, 0.4, 1.2]) {
      // legDriveMeters: 0 isolates the shuffle from the (default, nonzero)
      // leg-drive knob, which also moves the ankle near contact and would
      // otherwise leak into this measurement.
      const o: MockPassOptions = { footSpeedAtContact: speed, legDriveMeters: 0, noiseMeters: 0 };
      const seq = generateMockPass(o);
      const c = contactIndexFor(o);
      const before = seq.frames[c - 1]!.worldLandmarks![LM.LEFT_ANKLE]!;
      const after = seq.frames[c + 1]!.worldLandmarks![LM.LEFT_ANKLE]!;
      const dt = 2 / (o.fps ?? 60);
      const measuredSpeed = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) / dt;
      // Exact (before noise), same central-difference-of-a-line argument as
      // platformSwingDegreesPerSecond above.
      expect(measuredSpeed).toBeCloseTo(speed, 3);
    }
  });

  it("keeps the heel and foot-index moving with the ankle (rigid foot)", () => {
    const o: MockPassOptions = { footSpeedAtContact: 0.8, noiseMeters: 0 };
    const seq = generateMockPass(o);
    const c = contactIndexFor(o);
    const ankleBefore = seq.frames[c - 1]!.worldLandmarks![LM.LEFT_ANKLE]!;
    const ankleAfter = seq.frames[c + 1]!.worldLandmarks![LM.LEFT_ANKLE]!;
    const heelBefore = seq.frames[c - 1]!.worldLandmarks![LEFT_HEEL]!;
    const heelAfter = seq.frames[c + 1]!.worldLandmarks![LEFT_HEEL]!;
    const ankleDeltaZ = ankleAfter.z - ankleBefore.z;
    const heelDeltaZ = heelAfter.z - heelBefore.z;
    expect(heelDeltaZ).toBeCloseTo(ankleDeltaZ, 6);
  });
});

describe("generateMockPass — legDriveMeters", () => {
  it("grows the hip-to-ankle vertical separation toward contact when leg drive is requested", () => {
    const withDrive = generateMockPass({ legDriveMeters: 0.15, noiseMeters: 0 });
    const early = withDrive.frames[2]!.worldLandmarks![LM.LEFT_ANKLE]!.y;
    const atContact = withDrive.frames[contactIndexFor({})]!.worldLandmarks![LM.LEFT_ANKLE]!.y;
    expect(atContact).toBeGreaterThan(early + 0.1); // most of the 0.15m shows up vertically near-straight-legged

    const noDrive = generateMockPass({ legDriveMeters: 0, noiseMeters: 0 });
    const earlyFlat = noDrive.frames[2]!.worldLandmarks![LM.LEFT_ANKLE]!.y;
    const contactFlat = noDrive.frames[contactIndexFor({})]!.worldLandmarks![LM.LEFT_ANKLE]!.y;
    expect(Math.abs(contactFlat - earlyFlat)).toBeLessThan(0.01);
  });

  it("does not perturb the knee angle it shares a leg with", () => {
    // legDriveMeters stretches the shank's length, never its direction (see
    // buildLeg's comment), so the knee angle stays exactly kneeAngleAtContact
    // for every frame regardless of legDriveMeters.
    const seq = generateMockPass({ legDriveMeters: 0.3, kneeAngleAtContact: 140, noiseMeters: 0 });
    for (let i = 0; i < seq.frames.length; i += 15) {
      expect(worldKneeAngle(seq.frames[i]!, "LEFT")).toBeCloseTo(140, 6);
    }
  });
});

describe("generateMockPass — handSeparationMeters", () => {
  it("is recoverable as the distance between the wrists at contact", () => {
    // Straight-line (not just x-component) distance: the two wrists are built
    // level with each other (same local y and z) and `handSeparationMeters`
    // apart purely in x, so their 3D distance equals it exactly BEFORE the
    // default 45° camera-azimuth rotation mixes x and z together. Distance
    // between two points is preserved by any rigid rotation, so measuring the
    // full 3D distance (rather than reading world x directly, which is only
    // "lateral" at azimuth 0) recovers the knob regardless of camera angle —
    // exactly the property the rest of this file calls "azimuth invariance".
    for (const separation of [0, 0.1, 0.25]) {
      const o: MockPassOptions = { handSeparationMeters: separation, noiseMeters: 0 };
      const seq = generateMockPass(o);
      const frame = seq.frames[contactIndexFor(o)]!;
      const leftWrist = frame.worldLandmarks![LM.LEFT_WRIST]!;
      const rightWrist = frame.worldLandmarks![LM.RIGHT_WRIST]!;
      expect(distance(leftWrist, rightWrist)).toBeCloseTo(separation, 3);
    }
  });
});

// ---------------------------------------------------------------------------
// Anatomy / shape
// ---------------------------------------------------------------------------
describe("generateMockPass — landmark coverage", () => {
  it("fills all 33 landmark slots in both tracks, every frame", () => {
    const sequence = generateMockPass();
    for (const frame of sequence.frames) {
      expect(frame.landmarks).toHaveLength(33);
      expect(frame.worldLandmarks).toHaveLength(33);
    }
  });

  it("marks unmodelled landmarks (face, fingers) with low visibility", () => {
    const frame = generateMockPass().frames[10]!;
    // left_eye_inner — a face landmark this generator does not model.
    expect(frame.landmarks[1]!.visibility).toBeLessThan(0.5);
    expect(frame.worldLandmarks![1]!.visibility).toBeLessThan(0.5);
  });

  it("gives the modelled heel and foot-index landmarks high visibility", () => {
    const frame = generateMockPass().frames[10]!;
    for (const index of [LEFT_HEEL, RIGHT_HEEL, LEFT_FOOT_INDEX, RIGHT_FOOT_INDEX]) {
      expect(frame.landmarks[index]!.visibility).toBeGreaterThan(0.5);
    }
  });

  it("sets isMock", () => {
    expect(generateMockPass().isMock).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------
describe("generateMockPass — determinism", () => {
  it("produces an identical sequence for the same seed and options", () => {
    const a = generateMockPass({ seed: 42, noiseMeters: 0.02 });
    const b = generateMockPass({ seed: 42, noiseMeters: 0.02 });
    expect(a).toEqual(b);
  });

  it("produces a different sequence for a different seed", () => {
    const a = generateMockPass({ seed: 42, noiseMeters: 0.02 });
    const b = generateMockPass({ seed: 43, noiseMeters: 0.02 });
    expect(a).not.toEqual(b);
  });
});

// Sanity check that angleBetween/subtract are still exercised the way the
// rest of the suite assumes (guards against a bad import silently no-op'ing).
describe("test helpers", () => {
  it("worldElbowAngle matches a direct angleBetween computation", () => {
    const frame = generateMockPass({ noiseMeters: 0 }).frames[contactIndexFor({})]!;
    const w = frame.worldLandmarks!;
    const direct = angleBetween(
      subtract(w[LM.LEFT_SHOULDER]!, w[LM.LEFT_ELBOW]!),
      subtract(w[LM.LEFT_WRIST]!, w[LM.LEFT_ELBOW]!),
    );
    expect(worldElbowAngle(frame, "LEFT")).toBeCloseTo(direct!, 9);
  });
});
