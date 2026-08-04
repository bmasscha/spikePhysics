import { describe, expect, it } from "vitest";
import {
  ABDUCTION_DANGER_LOW,
  analyzeElbowTiming,
  analyzeKineticChain,
  analyzeSequence,
  calculateScaleFactor,
  classifyAbduction,
  detectCockingEndFrame,
  detectContactFrame,
  elbowFlexionSeries,
  jointSpeedSeries,
  medianOf,
  scaleFactorSeries,
  shoulderAbductionSeries,
  torsoLengthPixels,
} from "./biomechanics";
import { detectHittingSide, LM } from "./landmarks";
import { generateMockSequence } from "./mockData";
import { smoothSequence } from "./smoothing";
import type { PoseFrame, PoseLandmark } from "../types/pose";

/** Builds a frame from explicit pixel positions; unlisted joints are invisible. */
function frameFrom(
  points: Record<number, [number, number]>,
  index = 0,
  fps = 30,
): PoseFrame {
  const landmarks: PoseLandmark[] = Array.from({ length: 33 }, (_, i) => {
    const point = points[i];
    return {
      x: (point?.[0] ?? 0) / 1280,
      y: (point?.[1] ?? 0) / 720,
      z: 0,
      visibility: point ? 0.95 : 0,
      pixelX: point?.[0] ?? 0,
      pixelY: point?.[1] ?? 0,
      pixelZ: 0,
    } satisfies PoseLandmark;
  });
  return { index, timestampMs: (index * 1000) / fps, landmarks };
}

const TRUNK = {
  [LM.LEFT_SHOULDER]: [480, 300],
  [LM.RIGHT_SHOULDER]: [520, 300],
  [LM.LEFT_HIP]: [485, 450],
  [LM.RIGHT_HIP]: [515, 450],
} as Record<number, [number, number]>;

describe("A. dynamic scale factor", () => {
  it("measures the torso from shoulder midpoint to hip midpoint", () => {
    expect(torsoLengthPixels(frameFrom(TRUNK))).toBeCloseTo(150, 10);
  });

  it("returns torso-lengths per pixel", () => {
    expect(calculateScaleFactor(frameFrom(TRUNK))).toBeCloseTo(1 / 150, 12);
  });

  it("returns null when a trunk landmark is not visible", () => {
    const partial = { ...TRUNK };
    delete partial[LM.RIGHT_HIP];
    expect(calculateScaleFactor(frameFrom(partial))).toBeNull();
    expect(calculateScaleFactor(undefined)).toBeNull();
  });

  it("cancels perspective change: a player receding keeps a constant speed", () => {
    // Same real motion filmed at two distances must yield the same scaled speed.
    const near = frameFrom(TRUNK);
    const far = frameFrom({
      [LM.LEFT_SHOULDER]: [480, 300],
      [LM.RIGHT_SHOULDER]: [500, 300],
      [LM.LEFT_HIP]: [482, 375],
      [LM.RIGHT_HIP]: [498, 375],
    });
    expect(torsoLengthPixels(far)).toBeCloseTo(75, 10);
    // 20 px at the far distance is the same body-relative motion as 40 px near.
    const nearSpeed = 40 * calculateScaleFactor(near)!;
    const farSpeed = 20 * calculateScaleFactor(far)!;
    expect(nearSpeed).toBeCloseTo(farSpeed, 10);
  });

  it("takes the median of a per-frame series", () => {
    expect(medianOf([1, null, 3, 5])).toBe(3);
    expect(medianOf([null, null])).toBeNull();
  });
});

describe("B. shoulder abduction", () => {
  it("measures the upper arm against the shoulder line", () => {
    const frame = frameFrom({
      ...TRUNK,
      [LM.RIGHT_ELBOW]: [480, 260], // up and toward the opposite shoulder
    });
    const [angle] = shoulderAbductionSeries([frame], "right");
    expect(angle).toBeCloseTo(45, 6);
  });

  it("flags an arm that is too low", () => {
    const metric = classifyAbduction(100);
    expect(metric.rating).toBe("danger");
    expect(metric.detail).toMatch(/too low/i);
  });

  it("flags a hyper-abducted arm", () => {
    expect(classifyAbduction(150).rating).toBe("danger");
  });

  it("rates the 130-133 window as optimal", () => {
    expect(classifyAbduction(131).rating).toBe("optimal");
    expect(classifyAbduction(130).rating).toBe("optimal");
    expect(classifyAbduction(133).rating).toBe("optimal");
  });

  it("rates the safe-but-not-elite band as acceptable", () => {
    expect(classifyAbduction(120).rating).toBe("acceptable");
    expect(classifyAbduction(140).rating).toBe("acceptable");
  });

  it("reports unknown with a filming hint when the arm was lost", () => {
    const metric = classifyAbduction(null);
    expect(metric.rating).toBe("unknown");
    expect(metric.detail).toMatch(/perpendicular/i);
  });
});

describe("C. kinetic chain", () => {
  const scales = [1 / 150, 1 / 150, 1 / 150];

  it("scales joint speed by the per-frame torso length", () => {
    const frames = [
      frameFrom({ ...TRUNK, [LM.RIGHT_WRIST]: [500, 300] }, 0),
      frameFrom({ ...TRUNK, [LM.RIGHT_WRIST]: [530, 300] }, 1),
      frameFrom({ ...TRUNK, [LM.RIGHT_WRIST]: [590, 300] }, 2),
    ];
    const speeds = jointSpeedSeries(frames, LM.RIGHT_WRIST, scales);
    expect(speeds[0]).toBeNull(); // no previous sample
    expect(speeds[1]).toBeCloseTo((30 * 30) / 150, 8);
    expect(speeds[2]).toBeCloseTo((60 * 30) / 150, 8);
  });

  it("accepts a clean proximal-to-distal sequence", () => {
    const sequence = smoothSequence(generateMockSequence({ pattern: "clean" }));
    const result = analyzeKineticChain(
      sequence.frames,
      "right",
      scaleFactorSeries(sequence.frames),
    );
    expect(result.isSequenced).toBe(true);
    expect(result.rating).toBe("optimal");
    expect(result.observedOrder).toEqual(["hip", "shoulder", "elbow", "wrist"]);
  });

  it("emits the arm-forced warning when the hip peaks at or after the wrist", () => {
    const sequence = smoothSequence(generateMockSequence({ pattern: "broken" }));
    const result = analyzeKineticChain(
      sequence.frames,
      "right",
      scaleFactorSeries(sequence.frames),
    );
    expect(result.isSequenced).toBe(false);
    expect(result.rating).toBe("danger");
    expect(result.message).toContain("Broken Kinetic Chain");
    expect(result.message).toContain("early hip rotation");
  });

  it("reports unknown rather than guessing when a joint was never tracked", () => {
    const frames = [frameFrom(TRUNK, 0), frameFrom(TRUNK, 1)];
    const result = analyzeKineticChain(frames, "right", [1 / 150, 1 / 150]);
    expect(result.rating).toBe("unknown");
    expect(result.isSequenced).toBe(false);
  });
});

describe("D. elbow extension timing", () => {
  it("measures elbow flexion, 180 being a straight arm", () => {
    const straight = frameFrom({
      ...TRUNK,
      [LM.RIGHT_ELBOW]: [520, 380],
      [LM.RIGHT_WRIST]: [520, 460],
    });
    expect(elbowFlexionSeries([straight], "right")[0]).toBeCloseTo(180, 6);

    const bent = frameFrom({
      ...TRUNK,
      [LM.RIGHT_ELBOW]: [520, 380],
      [LM.RIGHT_WRIST]: [600, 380],
    });
    expect(elbowFlexionSeries([bent], "right")[0]).toBeCloseTo(90, 6);
  });

  it("locates the cocking reversal, not the arm hanging back on the approach", () => {
    const sequence = smoothSequence(generateMockSequence());
    const scales = scaleFactorSeries(sequence.frames);
    const contact = detectContactFrame(sequence.frames, "right", scales)!;
    const cocking = detectCockingEndFrame(sequence.frames, "right", contact)!;

    // The arm also trails behind the body early in the approach; the detector
    // must pick the reversal just before contact instead.
    expect(cocking).toBeGreaterThan(sequence.frames.length / 2);
    expect(cocking).toBeLessThan(contact);
  });

  it("rates an early extension as whip action", () => {
    const sequence = smoothSequence(
      generateMockSequence({ pattern: "clean", elbowOnsetRatio: 0.1 }),
    );
    const scales = scaleFactorSeries(sequence.frames);
    const elbow = elbowFlexionSeries(sequence.frames, "right");
    const contact = detectContactFrame(sequence.frames, "right", scales);
    const timing = analyzeElbowTiming(sequence.frames, "right", elbow, contact);

    expect(timing.onsetRatio).not.toBeNull();
    expect(timing.onsetRatio!).toBeLessThan(0.55);
    expect(timing.rating).toBe("optimal");
    expect(timing.label).toMatch(/Whip Action/);
  });

  it("rates a late extension as push action", () => {
    const sequence = smoothSequence(
      generateMockSequence({ pattern: "clean", elbowOnsetRatio: 0.9 }),
    );
    const scales = scaleFactorSeries(sequence.frames);
    const elbow = elbowFlexionSeries(sequence.frames, "right");
    const contact = detectContactFrame(sequence.frames, "right", scales);
    const timing = analyzeElbowTiming(sequence.frames, "right", elbow, contact);

    expect(timing.onsetRatio!).toBeGreaterThan(0.75);
    expect(timing.rating).toBe("danger");
    expect(timing.label).toMatch(/Push Action/);
  });

  it("degrades gracefully when contact cannot be located", () => {
    const timing = analyzeElbowTiming([], "right", [], null);
    expect(timing.rating).toBe("unknown");
    expect(timing.detail).toMatch(/contact/i);
  });
});

describe("analyzeSequence", () => {
  it("detects the hitting arm from wrist travel", () => {
    const sequence = generateMockSequence();
    expect(detectHittingSide(sequence.frames)).toBe("right");
  });

  it("produces a full dashboard payload for a clean spike", () => {
    const sequence = smoothSequence(generateMockSequence());
    const result = analyzeSequence(sequence);

    expect(result.hittingSide).toBe("right");
    expect(result.contactFrame).not.toBeNull();
    expect(result.abductionSeries).toHaveLength(sequence.frames.length);
    expect(result.elbowSeries).toHaveLength(sequence.frames.length);
    expect(result.kineticChain.series).toHaveLength(4);
    expect(result.warnings).toEqual([]);

    // The demo clip is built to land in the elite abduction window.
    expect(result.abductionAtContact.value!).toBeGreaterThan(128);
    expect(result.abductionAtContact.value!).toBeLessThan(136);

    // BaseAnalysis fields: keyFrame mirrors contactFrame for the spike shell.
    expect(result.technique).toBe("spike");
    expect(result.keyFrame).toBe(result.contactFrame);
  });

  it("recovers a built-in danger angle end to end", () => {
    const sequence = smoothSequence(generateMockSequence({ abductionAtContact: 105 }));
    const result = analyzeSequence(sequence);
    expect(result.abductionAtContact.value!).toBeLessThan(ABDUCTION_DANGER_LOW);
    expect(result.abductionAtContact.rating).toBe("danger");
  });

  it("respects an explicit hitting side override", () => {
    const sequence = generateMockSequence();
    expect(analyzeSequence(sequence, { hittingSide: "left" }).hittingSide).toBe("left");
  });

  it("never throws on an empty sequence", () => {
    const result = analyzeSequence({
      frames: [],
      fps: 30,
      videoWidth: 0,
      videoHeight: 0,
    });
    expect(result.contactFrame).toBeNull();
    expect(result.abductionAtContact.rating).toBe("unknown");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
