import { describe, expect, it } from "vitest";
import {
  movingAverage,
  savitzkyGolay,
  savitzkyGolayCoefficients,
  smoothSequence,
} from "./smoothing";
import { generateMockSequence } from "./mockData";

describe("movingAverage", () => {
  it("averages within a truncated window at the edges", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1.5, 2, 3, 4, 4.5]);
  });

  it("leaves a constant series untouched", () => {
    expect(movingAverage([7, 7, 7, 7], 5)).toEqual([7, 7, 7, 7]);
  });
});

describe("savitzkyGolayCoefficients", () => {
  it("reproduces the classic quadratic 5-point weights (-3,12,17,12,-3)/35", () => {
    const c = savitzkyGolayCoefficients(5, 2);
    const expected = [-3 / 35, 12 / 35, 17 / 35, 12 / 35, -3 / 35];
    c.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, 12));
  });

  it("sums to 1 so the filter preserves signal level", () => {
    const sum = savitzkyGolayCoefficients(7, 2).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("rejects an even window", () => {
    expect(() => savitzkyGolayCoefficients(4, 2)).toThrow();
  });
});

describe("savitzkyGolay", () => {
  it("passes a quadratic through unchanged (that is the point of the filter)", () => {
    const values = Array.from({ length: 21 }, (_, i) => 3 * i * i - 5 * i + 2);
    const smoothed = savitzkyGolay(values, 5, 2);
    // Interior points only; the edges fall back to a moving average.
    for (let i = 2; i < values.length - 2; i += 1) {
      expect(smoothed[i]!).toBeCloseTo(values[i]!, 8);
    }
  });

  it("attenuates alternating noise", () => {
    const clean = Array.from({ length: 40 }, (_, i) => Math.sin(i / 4));
    const noisy = clean.map((v, i) => v + (i % 2 === 0 ? 0.3 : -0.3));
    const smoothed = savitzkyGolay(noisy, 7, 2);

    const error = (series: number[]) =>
      series.reduce((acc, v, i) => acc + Math.abs(v - clean[i]!), 0);
    expect(error(smoothed)).toBeLessThan(error(noisy) * 0.6);
  });

  it("falls back to a moving average when the series is shorter than the window", () => {
    expect(savitzkyGolay([1, 2, 3], 5, 2)).toEqual(movingAverage([1, 2, 3], 5));
  });
});

describe("smoothSequence", () => {
  it("reduces jitter without mutating the input", () => {
    const sequence = generateMockSequence({ noisePixels: 4, seed: 7 });
    const before = sequence.frames[10]!.landmarks[16]!.pixelX;

    const smoothed = smoothSequence(sequence, { windowSize: 5, polyOrder: 2 });

    expect(sequence.frames[10]!.landmarks[16]!.pixelX).toBe(before);
    expect(smoothed.frames[10]!.landmarks[16]!.pixelX).not.toBe(before);
    expect(smoothed.frames).toHaveLength(sequence.frames.length);
  });

  it("keeps trajectories close to the raw path (no systematic drift)", () => {
    const sequence = generateMockSequence({ noisePixels: 2, seed: 11 });
    const smoothed = smoothSequence(sequence);

    let maxShift = 0;
    sequence.frames.forEach((frame, i) => {
      const raw = frame.landmarks[16]!;
      const filtered = smoothed.frames[i]!.landmarks[16]!;
      maxShift = Math.max(maxShift, Math.hypot(raw.pixelX - filtered.pixelX, raw.pixelY - filtered.pixelY));
    });
    expect(maxShift).toBeLessThan(15);
  });

  // World landmarks feed the passing technique's angle formulas the same way
  // the pixel track feeds the spike's, and their depth axis is the model's
  // noisiest — an unsmoothed world track would read as visibly jumpy angles.
  it("smooths world landmarks the same way it smooths pixel landmarks", () => {
    const sequence = generateMockSequence({ noisePixels: 4, seed: 7 });
    const before = sequence.frames[10]!.worldLandmarks![16]!.x;

    const smoothed = smoothSequence(sequence, { windowSize: 5, polyOrder: 2 });

    // Input is not mutated.
    expect(sequence.frames[10]!.worldLandmarks![16]!.x).toBe(before);
    // Output actually changed — the filter did something, not a no-op copy.
    expect(smoothed.frames[10]!.worldLandmarks![16]!.x).not.toBe(before);
    expect(smoothed.frames).toHaveLength(sequence.frames.length);
  });

  it("leaves frames without world landmarks completely untouched", () => {
    // A hand-built fixture, as described in PoseFrame's doc comment: pixel
    // landmarks only, no world data. Smoothing must not invent any. pixelX
    // has a deliberate wobble (not a straight ramp) so the Savitzky-Golay
    // filter actually changes it — a pure ramp is reproduced exactly and
    // would make the "smoothing ran" sanity check below a false negative.
    const pixelXs = [10, 22, 15, 41, 33];
    const sequence: ReturnType<typeof generateMockSequence> = {
      frames: pixelXs.map((pixelX, i) => ({
        index: i,
        timestampMs: i * 33,
        landmarks: [{ x: pixelX / 100, y: 0.2, z: 0, visibility: 1, pixelX, pixelY: 20, pixelZ: 0 }],
      })),
      fps: 30,
      videoWidth: 100,
      videoHeight: 100,
    };

    const smoothed = smoothSequence(sequence, { windowSize: 5, polyOrder: 2 });

    // Pixel smoothing still ran (sanity check this is the same code path)...
    expect(smoothed.frames[2]!.landmarks[0]!.pixelX).not.toBe(
      sequence.frames[2]!.landmarks[0]!.pixelX,
    );
    // ...but no worldLandmarks field was manufactured anywhere.
    smoothed.frames.forEach((frame) => expect(frame.worldLandmarks).toBeUndefined());
  });
});
