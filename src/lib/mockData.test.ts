import { describe, expect, it } from "vitest";
import { generateMockSequence } from "./mockData";
import { LM, spatialPoint } from "./landmarks";
import { angleAt, midpoint } from "./vectorMath";

// These tests exercise the synthetic world-landmark track added alongside the
// existing pixel one (see mockData.ts's comment on NOMINAL_TORSO_METERS).
// The mock is planar (z: 0 throughout, both pixel and world), so nothing here
// can validate depth-axis behaviour — only that the in-plane conversion from
// pixels to metres is a faithful similarity transform.
describe("generateMockSequence world landmarks", () => {
  it("centres the hip midpoint on the origin every frame", () => {
    // This holds by construction (world coordinates are pixel coordinates
    // minus the hip midpoint, then scaled), so it should be exact, not
    // merely close, regardless of the pixel jitter applied to each hip
    // landmark independently.
    const sequence = generateMockSequence();
    for (const frame of sequence.frames) {
      const leftHip = frame.worldLandmarks![LM.LEFT_HIP]!;
      const rightHip = frame.worldLandmarks![LM.RIGHT_HIP]!;
      const hipMid = midpoint(leftHip, rightHip);
      expect(hipMid.x).toBeCloseTo(0, 9);
      expect(hipMid.y).toBeCloseTo(0, 9);
      expect(hipMid.z).toBeCloseTo(0, 9);
    }
  });

  it("holds the shoulder-to-hip distance at the nominal 0.5 m torso", () => {
    // Noise-free so the per-frame scale factor (0.5 / this frame's own pixel
    // torso length) can be checked exactly, including through the
    // `perspective` shrink that makes the pixel torso shorter later in the
    // clip — proving the scale is re-derived every frame, not a constant
    // baked in once.
    const sequence = generateMockSequence({ noisePixels: 0 });
    for (const frame of sequence.frames) {
      const shoulderMid = midpoint(
        frame.worldLandmarks![LM.LEFT_SHOULDER]!,
        frame.worldLandmarks![LM.RIGHT_SHOULDER]!,
      );
      const hipMid = midpoint(
        frame.worldLandmarks![LM.LEFT_HIP]!,
        frame.worldLandmarks![LM.RIGHT_HIP]!,
      );
      const torso = Math.hypot(
        shoulderMid.x - hipMid.x,
        shoulderMid.y - hipMid.y,
        shoulderMid.z - hipMid.z,
      );
      expect(torso).toBeCloseTo(0.5, 9);
    }
  });

  it("stays within a few centimetres of 0.5 m once ordinary pixel jitter is applied", () => {
    // Same measurement as above but with the default noise level, so this
    // covers the realistic (noisy) path instead of only the idealised one.
    const sequence = generateMockSequence();
    for (const frame of sequence.frames) {
      const shoulderMid = midpoint(
        frame.worldLandmarks![LM.LEFT_SHOULDER]!,
        frame.worldLandmarks![LM.RIGHT_SHOULDER]!,
      );
      const hipMid = midpoint(
        frame.worldLandmarks![LM.LEFT_HIP]!,
        frame.worldLandmarks![LM.RIGHT_HIP]!,
      );
      const torso = Math.hypot(
        shoulderMid.x - hipMid.x,
        shoulderMid.y - hipMid.y,
        shoulderMid.z - hipMid.z,
      );
      expect(torso).toBeGreaterThan(0.45);
      expect(torso).toBeLessThan(0.55);
    }
  });

  it("keeps the world-space knee angle consistent with the pixel-space one", () => {
    // The world track is an affine map of the pixel track (translate to the
    // hip midpoint, then a uniform scale) — a transform that preserves
    // angles exactly. Checking a 3D angle computed from world coordinates
    // against the same angle from pixel coordinates is the test that proves
    // the pixel->metre conversion is not silently distorting the skeleton;
    // if it were e.g. scaling x and y differently, this would fail.
    const sequence = generateMockSequence({ noisePixels: 2, seed: 99 });

    for (let i = 0; i < sequence.frames.length; i += 8) {
      const frame = sequence.frames[i]!;
      const pixelAngle = angleAt(
        spatialPoint(frame.landmarks[LM.RIGHT_KNEE]!),
        spatialPoint(frame.landmarks[LM.RIGHT_HIP]!),
        spatialPoint(frame.landmarks[LM.RIGHT_ANKLE]!),
      );
      const worldAngle = angleAt(
        frame.worldLandmarks![LM.RIGHT_KNEE]!,
        frame.worldLandmarks![LM.RIGHT_HIP]!,
        frame.worldLandmarks![LM.RIGHT_ANKLE]!,
      );
      expect(worldAngle).not.toBeNull();
      expect(pixelAngle).not.toBeNull();
      expect(worldAngle!).toBeCloseTo(pixelAngle!, 6);
    }
  });

  it("mirrors pixel visibility onto the matching world landmark", () => {
    const sequence = generateMockSequence();
    const frame = sequence.frames[10]!;
    frame.landmarks.forEach((lm, i) => {
      expect(frame.worldLandmarks![i]!.visibility).toBe(lm.visibility);
    });
  });
});
