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

/**
 * A landmark in MediaPipe's world space: metres, origin at the hip midpoint.
 *
 * Why this exists alongside the pixel landmarks. Image-space coordinates encode
 * the camera's viewpoint — a limb pointing at the lens is short on screen no
 * matter how long it is — so any angle read off them is only true when that
 * limb lies in the image plane. The spike gets away with pixel space because
 * the app asks for a side-on camera, which puts the swing in that plane.
 * Serve-receive is filmed at ~45°, where nothing is in the image plane, so its
 * angles are computed here instead.
 *
 * Axes follow MediaPipe's camera convention, not a textbook maths one:
 * x right, y DOWN, z AWAY from the camera. MediaPipe words it from the other
 * end — "the smaller the value the closer the landmark is to the camera" —
 * which is the same statement and is easy to read backwards. Getting it
 * backwards inverts anything built on a cross product, so derive a basis from
 * the body (lib/bodyFrame.ts) rather than trusting a raw axis, and check that
 * module's handedness tests before changing any sign here.
 *
 * These are still a monocular estimate: depth is inferred by the model, never
 * measured. It is the weakest of the three axes and no amount of geometry
 * downstream can recover what the model guessed wrong.
 */
export interface WorldLandmark {
  /** Metres, positive to the subject's image-right. */
  x: number;
  /** Metres, positive DOWN. */
  y: number;
  /** Metres, positive AWAY from the camera (smaller = closer). */
  z: number;
  /** MediaPipe confidence that the landmark is visible, [0,1]. */
  visibility: number;
}

export interface PoseFrame {
  /** 0-based index within the trimmed clip. */
  index: number;
  /** Presentation time within the clip, in milliseconds. */
  timestampMs: number;
  /** 33 MediaPipe landmarks, or an empty array when no pose was detected. */
  landmarks: PoseLandmark[];
  /**
   * The same 33 landmarks in metric world space, when available.
   *
   * Optional because a hand-built test fixture need not carry them, not
   * because real captures might skip them: poseEngine fills this for every
   * frame it detects a pose in. An analysis that needs world space and finds
   * none must say so in its warnings rather than quietly returning nulls.
   */
  worldLandmarks?: WorldLandmark[];
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
