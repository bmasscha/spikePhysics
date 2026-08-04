/**
 * Shared pose/analysis types.
 *
 * Note on naming: the design brief writes landmark pixel coordinates as
 * `pixel_x` / `pixel_y` (carried over from the Python analyzers). This codebase
 * uses camelCase `pixelX` / `pixelY` to stay idiomatic in TypeScript; the
 * meaning is identical.
 */

export interface PoseLandmark {
  /** Normalized [0,1] horizontal position within the frame. */
  x: number;
  /** Normalized [0,1] vertical position, measured DOWN from the top edge. */
  y: number;
  /** Depth relative to the hip midpoint, roughly in the same scale as x. */
  z: number;
  /** MediaPipe confidence that the landmark is visible, [0,1]. */
  visibility: number;
  /** x * videoWidth */
  pixelX: number;
  /** y * videoHeight */
  pixelY: number;
  /**
   * z * videoWidth — depth on the same isotropic scale as pixelX/pixelY.
   *
   * Angles must never be computed from the normalized x/y/z: those divide x by
   * the frame width and y by the height, so on a 16:9 clip the vertical axis is
   * stretched by 1.78x and every measured angle is wrong. MediaPipe scales z
   * like x, hence the multiplication by width here.
   */
  pixelZ: number;
}

export interface PoseFrame {
  /** 0-based index within the trimmed clip. */
  index: number;
  /** Presentation time within the clip, in milliseconds. */
  timestampMs: number;
  /** 33 MediaPipe landmarks, or an empty array when no pose was detected. */
  landmarks: PoseLandmark[];
}

export interface PoseSequence {
  frames: PoseFrame[];
  fps: number;
  videoWidth: number;
  videoHeight: number;
  /** True when the sequence came from the mock generator, not a real camera. */
  isMock?: boolean;
}

/** Which arm is hitting. Everything anatomical is mirrored off this. */
export type HittingSide = "left" | "right";

export type Rating = "optimal" | "acceptable" | "danger" | "unknown";

export interface Metric<T = number> {
  value: T | null;
  rating: Rating;
  label: string;
  detail: string;
}

/*
 * Technique-specific result types live next to their technique:
 * spike → types/spike.ts, and the shared shell contract → types/technique.ts.
 */
