/**
 * poseEngine.ts — client-side MediaPipe Tasks-Vision wrapper.
 *
 * Everything here is local: the Wasm runtime is served from /wasm and the model
 * from /models, both precached by the service worker. No network call is made
 * at runtime, which is what makes the app usable in a gym with no Wi-Fi and
 * keeps youth-player footage on the tablet (§5).
 */

import {
  FilesetResolver,
  PoseLandmarker,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import type { PoseFrame, PoseLandmark, PoseSequence, WorldLandmark } from "../types/pose";

// Base-relative, not absolute: on GitHub Pages the app is served from
// /spikePhysics/, where a leading-slash path would 404.
const BASE = import.meta.env.BASE_URL;
const WASM_PATH = `${BASE}wasm`;
const MODEL_PATH = `${BASE}models/pose_landmarker_full.task`;

export class PoseEngineError extends Error {
  constructor(
    message: string,
    /** Coach-facing recovery hint (§7.3). */
    readonly hint: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PoseEngineError";
  }
}

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

/** Loads (once) and returns the PoseLandmarker in VIDEO running mode. */
export async function getPoseLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      try {
        const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
        return await PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        });
      } catch (error) {
        landmarkerPromise = null; // allow a retry after a transient failure
        throw new PoseEngineError(
          "Pose engine failed to initialise",
          "The pose model could not be loaded. Open the app once with a network connection so it can cache itself, then try again.",
          error,
        );
      }
    })();
  }
  return landmarkerPromise;
}

/** Frees GPU/Wasm resources — call from the "Delete Session" flow. */
export function disposePoseLandmarker(): void {
  const pending = landmarkerPromise;
  landmarkerPromise = null;
  void pending?.then((l) => l.close()).catch(() => undefined);
}

/**
 * Sampling rate for inference, including for 120/240 fps slow-motion imports.
 *
 * Why a fixed 30 rather than following the source: no browser API reports a
 * file's native frame rate. The usual stand-in, `getVideoPlaybackQuality()`,
 * counts frames presented since the element was created — but the review stage
 * seeks instead of playing, so that counter is driven by trim-slider scrubbing,
 * not by elapsed media time. Dividing it by `currentTime` reads as "hundreds of
 * fps" for any coach who trims near the start of a short clip, which is a
 * completely ordinary thing to do.
 *
 * Guessing high is not a harmless default. Sampling faster than the source
 * makes consecutive seeks land on the *same* decoded frame, so the landmarks
 * repeat, the finite-difference speeds alternate between a real value and zero,
 * and the kinetic-chain peak ordering is read off a sawtooth. A wrong rate here
 * corrupts results rather than merely slowing things down, so the rate stays
 * fixed until it can be measured rather than inferred.
 *
 * What is given up: the swing from cocking to contact lasts ~200 ms, so 30 fps
 * locates each joint's peak-speed frame to ±33 ms. Doubling the rate would
 * halve that, at the cost of doubling a pass that is already seek-plus-
 * inference bound (~15–30 ms per frame on a tablet GPU). Measuring the source
 * rate properly needs a `requestVideoFrameCallback` burst before processing;
 * that is the follow-up if the extra temporal resolution is wanted.
 *
 * Note for slow-motion footage: `timestampMs` is media time, so if the camera
 * app already time-stretched the clip (240 fps captured, written back as a
 * 30 fps file that plays 8x slow), the speeds reported are the *played* speeds,
 * not the athlete's. Export slow motion at its real rate for true figures.
 */
export const DEFAULT_SAMPLE_FPS = 30;

export interface ProcessOptions {
  /** Clip window in seconds, from the trim slider. */
  startSeconds?: number;
  endSeconds?: number;
  /** Sampling rate for inference. See {@link DEFAULT_SAMPLE_FPS}. */
  targetFps?: number;
  /** Abort if a single frame takes longer than this. */
  frameTimeoutMs?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Result of a single frame's landmark extraction: pixel-space landmarks plus,
 * when a pose was detected, MediaPipe's parallel metric world-space track.
 *
 * `worldLandmarks` is left `undefined` — not `[]` — exactly when `landmarks`
 * is `[]`, i.e. no pose was found. Keeping the two "no detection" signals
 * identical (absent, not an empty array pretending to be data) means callers
 * can gate on either field with a single truthiness/length check instead of
 * juggling two different empty states.
 */
interface ExtractedLandmarks {
  landmarks: PoseLandmark[];
  worldLandmarks?: WorldLandmark[];
}

function toLandmarks(
  result: PoseLandmarkerResult,
  width: number,
  height: number,
): ExtractedLandmarks {
  const pose = result.landmarks[0];
  if (!pose) return { landmarks: [] };

  // World landmarks are MediaPipe's separate metric-space output (metres,
  // origin at the hip midpoint) — see types/pose.ts's WorldLandmark doc for
  // why the passing analysis needs them and the spike doesn't. They are
  // produced alongside `landmarks` whenever a pose is detected, but indexed
  // access still needs the `?.` guards below in case a future model build
  // ever omits a point the pixel track has.
  const world = result.worldLandmarks[0];

  const landmarks = pose.map((lm, i) => ({
    x: lm.x,
    y: lm.y,
    z: lm.z,
    // `visibility` is optional in the typings but populated by this model.
    visibility: world?.[i]?.visibility ?? lm.visibility ?? 1,
    pixelX: lm.x * width,
    pixelY: lm.y * height,
    // MediaPipe scales z like x, so width (not height) is the right factor.
    pixelZ: lm.z * width,
  }));

  const worldLandmarks: WorldLandmark[] | undefined = world?.map((wlm) => ({
    x: wlm.x,
    y: wlm.y,
    z: wlm.z,
    visibility: wlm.visibility ?? 1,
  }));

  return { landmarks, worldLandmarks };
}

/**
 * Steps a video element through the trimmed window, running inference on each
 * sampled frame. Seeking (rather than playing) makes the pass deterministic and
 * as fast as the device allows, instead of real-time.
 */
export async function processVideoElement(
  video: HTMLVideoElement,
  options: ProcessOptions = {},
): Promise<PoseSequence> {
  const {
    startSeconds = 0,
    endSeconds = video.duration,
    targetFps = DEFAULT_SAMPLE_FPS,
    frameTimeoutMs = 4000,
    onProgress,
    signal,
  } = options;

  if (!Number.isFinite(video.duration) || video.duration === 0) {
    throw new PoseEngineError(
      "Video metadata not ready",
      "This clip could not be read. Pick another file, or record directly in SpikePhysics.",
    );
  }

  const landmarker = await getPoseLandmarker();
  // Rotation needs no correction here: the HTML spec defines videoWidth/
  // videoHeight as the dimensions *after* the container's rotation matrix is
  // applied, and MediaPipe reads the same already-rotated frame we hand it. So
  // a portrait phone clip reports e.g. 1080x1920 and the normalized landmarks
  // are relative to that upright frame — which is exactly the space
  // SkeletonOverlay draws in. Nothing to unwind.
  const width = video.videoWidth;
  const height = video.videoHeight;
  const end = Math.min(endSeconds, video.duration);
  const step = 1 / targetFps;
  const frameCount = Math.max(1, Math.floor((end - startSeconds) / step));

  const frames: PoseFrame[] = [];
  let missedFrames = 0;

  for (let i = 0; i < frameCount; i += 1) {
    if (signal?.aborted) throw new PoseEngineError("Cancelled", "Processing cancelled.");

    const time = startSeconds + i * step;
    await seekTo(video, time, frameTimeoutMs);

    const result = landmarker.detectForVideo(video, time * 1000);
    const { landmarks, worldLandmarks } = toLandmarks(result, width, height);
    if (landmarks.length === 0) missedFrames += 1;

    // timestampMs is derived from the real media time, never from the frame
    // index — dt everywhere in the physics reads it, so it must stay truthful
    // whatever sampling rate was chosen above.
    frames.push({
      index: i,
      timestampMs: (time - startSeconds) * 1000,
      landmarks,
      worldLandmarks,
    });
    onProgress?.((i + 1) / frameCount);
  }

  if (frames.length === 0 || missedFrames === frames.length) {
    throw new PoseEngineError(
      "No pose detected",
      "No player was detected. Make sure the camera is perpendicular to the player and the whole body is in frame.",
    );
  }

  // fps must report the rate actually sampled, not the default — smoothing
  // window sizes and every per-second figure downstream are derived from it.
  return { frames, fps: targetFps, videoWidth: width, videoHeight: height };
}

function seekTo(video: HTMLVideoElement, time: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(
        new PoseEngineError(
          `Timed out seeking to ${time.toFixed(2)}s`,
          "Processing stalled. Try a shorter clip, or reload the app.",
        ),
      );
    }, timeoutMs);

    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = time;
  });
}
