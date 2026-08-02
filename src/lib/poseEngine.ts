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
import type { PoseFrame, PoseLandmark, PoseSequence } from "../types/pose";

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

export interface ProcessOptions {
  /** Clip window in seconds, from the trim slider. */
  startSeconds?: number;
  endSeconds?: number;
  /** Sampling rate for inference. 30 keeps a 5 s clip under ~150 frames. */
  targetFps?: number;
  /** Abort if a single frame takes longer than this. */
  frameTimeoutMs?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function toLandmarks(
  result: PoseLandmarkerResult,
  width: number,
  height: number,
): PoseLandmark[] {
  const pose = result.landmarks[0];
  if (!pose) return [];
  return pose.map((lm, i) => ({
    x: lm.x,
    y: lm.y,
    z: lm.z,
    // `visibility` is optional in the typings but populated by this model.
    visibility: result.worldLandmarks[0]?.[i]?.visibility ?? lm.visibility ?? 1,
    pixelX: lm.x * width,
    pixelY: lm.y * height,
    // MediaPipe scales z like x, so width (not height) is the right factor.
    pixelZ: lm.z * width,
  }));
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
    targetFps = 30,
    frameTimeoutMs = 4000,
    onProgress,
    signal,
  } = options;

  if (!Number.isFinite(video.duration) || video.duration === 0) {
    throw new PoseEngineError(
      "Video metadata not ready",
      "The recording could not be read. Record the clip again.",
    );
  }

  const landmarker = await getPoseLandmarker();
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
    const landmarks = toLandmarks(result, width, height);
    if (landmarks.length === 0) missedFrames += 1;

    frames.push({ index: i, timestampMs: (time - startSeconds) * 1000, landmarks });
    onProgress?.((i + 1) / frameCount);
  }

  if (frames.length === 0 || missedFrames === frames.length) {
    throw new PoseEngineError(
      "No pose detected",
      "No player was detected. Make sure the camera is perpendicular to the player and the whole body is in frame.",
    );
  }

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
