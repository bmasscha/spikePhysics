/**
 * smoothing.ts — jitter removal for landmark trajectories.
 *
 * MediaPipe landmark coordinates carry a few pixels of frame-to-frame noise.
 * Differentiating that raw signal (velocity, angular velocity) amplifies it into
 * spurious peaks, which is exactly what the kinetic-chain check keys on — so the
 * whole physics layer runs on smoothed coordinates.
 *
 * Savitzky-Golay is preferred over a plain moving average because it fits a
 * local polynomial and therefore preserves peak height and peak timing, which a
 * boxcar filter flattens and shifts.
 */

import type { PoseFrame, PoseSequence } from "../types/pose";

export type SmoothingMethod = "savgol" | "movingAverage" | "none";

export interface SmoothingOptions {
  method?: SmoothingMethod;
  /** Must be odd and >= 3. Defaults to 5 frames, as specified in the brief. */
  windowSize?: number;
  /** Polynomial order for Savitzky-Golay; must be < windowSize. */
  polyOrder?: number;
}

const DEFAULTS: Required<SmoothingOptions> = {
  method: "savgol",
  windowSize: 5,
  polyOrder: 2,
};

// ---------------------------------------------------------------------------
// 1D filters
// ---------------------------------------------------------------------------

/**
 * Centred moving average. Windows are truncated at the series edges rather than
 * padded, so the first and last samples stay unbiased.
 */
export function movingAverage(
  values: readonly number[],
  windowSize = DEFAULTS.windowSize,
): number[] {
  const n = values.length;
  if (n === 0) return [];
  const half = Math.floor(Math.max(1, windowSize) / 2);
  const out = new Array<number>(n);

  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k += 1) {
      sum += values[k]!;
      count += 1;
    }
    out[i] = sum / count;
  }
  return out;
}

/**
 * Savitzky-Golay smoothing coefficients for the centre point of a window.
 *
 * Solves the normal equations (Vᵀ V) c = Vᵀ e₀ for the Vandermonde matrix V of
 * the window offsets, which gives the convolution weights directly. Computed at
 * call time rather than table-looked-up so any (window, order) pair works.
 */
export function savitzkyGolayCoefficients(
  windowSize: number,
  polyOrder: number,
): number[] {
  if (windowSize % 2 === 0) throw new Error("windowSize must be odd");
  if (polyOrder >= windowSize) throw new Error("polyOrder must be < windowSize");

  const half = (windowSize - 1) / 2;
  const order = polyOrder + 1;

  // Gram matrix A = VᵀV, where V[i][j] = offset_i ^ j
  const a: number[][] = Array.from({ length: order }, () =>
    new Array<number>(order).fill(0),
  );
  for (let i = -half; i <= half; i += 1) {
    for (let r = 0; r < order; r += 1) {
      for (let c = 0; c < order; c += 1) {
        a[r]![c]! += Math.pow(i, r + c);
      }
    }
  }

  // Solve A x = e₀ by Gauss-Jordan; the first row of A⁻¹ is what we need.
  const inverseFirstRow = solveFirstRow(a, order);

  // Weight of sample at offset i is Σ_j inv[0][j] * i^j
  const coefficients: number[] = [];
  for (let i = -half; i <= half; i += 1) {
    let w = 0;
    for (let j = 0; j < order; j += 1) w += inverseFirstRow[j]! * Math.pow(i, j);
    coefficients.push(w);
  }
  return coefficients;
}

/** Gauss-Jordan solve of A x = e₀ with partial pivoting. */
function solveFirstRow(a: number[][], size: number): number[] {
  const m = a.map((row, i) => [...row, i === 0 ? 1 : 0]);

  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < size; r += 1) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) {
      throw new Error("Singular Savitzky-Golay system");
    }
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];

    const div = m[col]![col]!;
    for (let c = col; c <= size; c += 1) m[col]![c]! /= div;

    for (let r = 0; r < size; r += 1) {
      if (r === col) continue;
      const factor = m[r]![col]!;
      if (factor === 0) continue;
      for (let c = col; c <= size; c += 1) m[r]![c]! -= factor * m[col]![c]!;
    }
  }
  return m.map((row) => row[size]!);
}

/**
 * Savitzky-Golay filter over a scalar series. Samples closer to an edge than
 * half a window fall back to a truncated moving average, which avoids the
 * end-point overshoot that mirror-padding produces on a fast swing.
 */
export function savitzkyGolay(
  values: readonly number[],
  windowSize = DEFAULTS.windowSize,
  polyOrder = DEFAULTS.polyOrder,
): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (windowSize % 2 === 0) windowSize += 1;
  if (n < windowSize || polyOrder >= windowSize) {
    return movingAverage(values, windowSize);
  }

  const half = (windowSize - 1) / 2;
  const coefficients = savitzkyGolayCoefficients(windowSize, polyOrder);
  const edge = movingAverage(values, windowSize);
  const out = new Array<number>(n);

  for (let i = 0; i < n; i += 1) {
    if (i < half || i >= n - half) {
      out[i] = edge[i]!;
      continue;
    }
    let acc = 0;
    for (let k = -half; k <= half; k += 1) {
      acc += coefficients[k + half]! * values[i + k]!;
    }
    out[i] = acc;
  }
  return out;
}

export function smoothSeries(
  values: readonly number[],
  options: SmoothingOptions = {},
): number[] {
  const { method, windowSize, polyOrder } = { ...DEFAULTS, ...options };
  switch (method) {
    case "none":
      return [...values];
    case "movingAverage":
      return movingAverage(values, windowSize);
    case "savgol":
    default:
      return savitzkyGolay(values, windowSize, polyOrder);
  }
}

// ---------------------------------------------------------------------------
// Sequence-level smoothing
// ---------------------------------------------------------------------------

/**
 * Smooths every coordinate channel of every landmark across time.
 *
 * Frames where a landmark dropped below the visibility threshold are excluded
 * from the filter input and left untouched in the output — smoothing across a
 * detection gap would drag the trajectory toward a phantom position.
 *
 * Returns a new sequence; the input is not mutated.
 */
export function smoothSequence(
  sequence: PoseSequence,
  options: SmoothingOptions = {},
): PoseSequence {
  const { frames } = sequence;
  if (frames.length === 0) return sequence;

  const landmarkCount = Math.max(...frames.map((f) => f.landmarks.length));
  if (!Number.isFinite(landmarkCount) || landmarkCount === 0) return sequence;

  const output: PoseFrame[] = frames.map((frame) => ({
    ...frame,
    landmarks: frame.landmarks.map((lm) => ({ ...lm })),
  }));

  const channels = ["x", "y", "z", "pixelX", "pixelY", "pixelZ"] as const;

  for (let index = 0; index < landmarkCount; index += 1) {
    // Contiguous runs of tracked frames are smoothed independently.
    let runStart = -1;
    for (let f = 0; f <= frames.length; f += 1) {
      const tracked = f < frames.length && frames[f]!.landmarks[index] != null;
      if (tracked && runStart === -1) runStart = f;
      if (!tracked && runStart !== -1) {
        smoothRun(output, index, runStart, f, channels, options);
        runStart = -1;
      }
    }
  }

  return { ...sequence, frames: output };
}

function smoothRun(
  frames: PoseFrame[],
  landmarkIndex: number,
  start: number,
  end: number,
  channels: readonly ("x" | "y" | "z" | "pixelX" | "pixelY" | "pixelZ")[],
  options: SmoothingOptions,
): void {
  const length = end - start;
  if (length < 3) return;

  for (const channel of channels) {
    const raw = new Array<number>(length);
    for (let i = 0; i < length; i += 1) {
      raw[i] = frames[start + i]!.landmarks[landmarkIndex]![channel];
    }
    const smoothed = smoothSeries(raw, options);
    for (let i = 0; i < length; i += 1) {
      frames[start + i]!.landmarks[landmarkIndex]![channel] = smoothed[i]!;
    }
  }
}
