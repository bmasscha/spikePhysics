/**
 * mockData.ts — synthetic spike generator (§7.1 of the brief).
 *
 * Produces a physically plausible pose sequence so the dashboard, charts and
 * play-head can be developed and tested with no camera, no MediaPipe and no
 * model file. It is also what the unit tests analyse, since a hand-built
 * skeleton has a *known* correct answer.
 *
 * The skeleton is driven forward-kinematically from four time-varying inputs —
 * body translation, trunk rotation, shoulder abduction and elbow extension —
 * each ramping at a different moment. That is the real mechanism behind the
 * kinetic chain, so a correctly sequenced clip falls out of the model rather
 * than being faked.
 */

import { LM } from "./landmarks";
import type { PoseLandmark, PoseFrame, PoseSequence, WorldLandmark } from "../types/pose";

export interface MockOptions {
  fps?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  /**
   * Shoulder abduction the arm is built to reach, in degrees. The value the
   * analysis then *measures* lands 3–5° lower, because contact is detected a
   * frame or two before the arm fully settles — treat this as ±5°.
   */
  abductionAtContact?: number;
  /**
   * Fraction of the cocking→contact window at which the elbow starts to extend.
   * Useful range is 0–0.9; at 1.0 extension coincides with contact and there is
   * no swing left to measure.
   */
  elbowOnsetRatio?: number;
  /** "clean" sequences hip→wrist; "broken" fires the arm before the hips. */
  pattern?: "clean" | "broken";
  /** Std-dev of the pixel jitter added to every landmark. */
  noisePixels?: number;
  seed?: number;
}

/**
 * Nominal shoulder-midpoint-to-hip-midpoint torso length used to derive the
 * pixel→metre conversion for the synthetic world landmarks, in metres. 0.5 m
 * is a reasonable adult figure. It is deliberately a single constant fed
 * through a per-frame scale factor (`0.5 / torsoLength`, where `torsoLength`
 * is *this generator's own* pixel torso for the frame) rather than a fixed
 * pixels-per-metre number: the pixel rig already shrinks the torso with
 * `perspective` to fake the player moving away from the camera, and the
 * world track must not inherit that as if the athlete were physically
 * shrinking — exactly the distortion the app's real dynamic scale-factor
 * calibration (§4A) exists to cancel from actual footage.
 */
const NOMINAL_TORSO_METERS = 0.5;

const DEFAULTS: Required<MockOptions> = {
  // 60 fps: a spike's cocking→contact window is ~150 ms, which 30 fps resolves
  // into only 4–5 samples — too coarse to time the elbow against.
  fps: 60,
  durationSeconds: 1.6,
  width: 1280,
  height: 720,
  // Built at 135° so the demo clip *measures* in the 130–133° elite window.
  abductionAtContact: 135,
  elbowOnsetRatio: 0.45,
  pattern: "clean",
  noisePixels: 1.2,
  seed: 20260802,
};

/**
 * Deterministic PRNG so mock clips and their tests are reproducible.
 * Exported so mockPass.ts (the serve-receive fixture) can reuse the same
 * generator rather than maintaining a second copy — the two mocks share no
 * other code, since one builds pixel-first and the other metric-first.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 0→1 ramp centred on `center`, reaching ~full value over `width`. */
function ramp(t: number, center: number, width: number): number {
  return 1 / (1 + Math.exp(-(t - center) / (width / 6)));
}

/**
 * Accelerating 0→1 profile: zero before `start`, exactly 1 at `end`, with its
 * rate still rising at `end` and frozen afterwards. Used for the segments whose
 * peak speed must land on contact regardless of when they began moving.
 */
function accelerate(t: number, start: number, end: number): number {
  const p = Math.min(1, Math.max(0, (t - start) / Math.max(0.02, end - start)));
  return p * p;
}

function rotate(
  origin: { x: number; y: number },
  length: number,
  degrees: number,
): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180;
  // Screen space is y-down, so subtract the sine component to point "up".
  return { x: origin.x + length * Math.cos(rad), y: origin.y - length * Math.sin(rad) };
}

export function generateMockSequence(options: MockOptions = {}): PoseSequence {
  const o = { ...DEFAULTS, ...options };
  const random = mulberry32(o.seed);
  const frameCount = Math.max(8, Math.round(o.fps * o.durationSeconds));

  // --- Timing of each segment's contribution -------------------------------
  // Each joint inherits the motion of every joint above it in the chain, so a
  // segment only peaks at its own moment when its own contribution beats the
  // inherited one. Amplitudes below are tuned for exactly that: hip < shoulder
  // < elbow < wrist in peak magnitude as well as in time, which is what makes
  // "clean" technique come out sequenced.
  const T_MER = 0.62; // arm furthest back = end of the cocking phase
  const T_CONTACT = 0.84; // arm reaches the target angle; peak wrist speed
  const timing =
    o.pattern === "clean"
      ? { body: 0.3, trunk: 0.5, takeoff: 0.38 }
      : // Broken: the arm fires first and the hips arrive late, so the peaks
        // come out reversed.
        { body: 0.9, trunk: 0.88, takeoff: 0.72 };

  // Extension onset sits inside the cocking→contact window, so `elbowOnsetRatio`
  // is precisely the quantity analyzeElbowTiming has to recover.
  const extensionOnsetTime = T_MER + o.elbowOnsetRatio * (T_CONTACT - T_MER);
  // Extension runs slightly past contact, so the wrist's speed peak lands one
  // frame after the elbow's instead of tying with it — as it does in reality,
  // where the hand is still extending through the ball.
  const extensionEnd = T_CONTACT + 0.04;

  const frames: PoseFrame[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    const t = i / (frameCount - 1);

    // --- Whole-body motion: approach run, then a jump arc.
    const approach = ramp(t, timing.body, 0.36);
    const hipX = 400 + 170 * approach;
    // Take-off is staggered after the horizontal peak, the way a real plant
    // converts run-up speed into height.
    const jump = Math.max(
      0,
      Math.sin(Math.PI * Math.min(1, Math.max(0, (t - timing.takeoff) / 0.62))),
    );
    const hipY = 470 - 120 * jump;

    // Torso length shrinks slightly as the player moves away from the camera:
    // exactly the distortion the dynamic scale factor exists to cancel.
    const perspective = 1 - 0.08 * approach;
    const torsoLength = 150 * perspective;
    const upperArm = 78 * perspective;
    const foreArm = 72 * perspective;
    const thigh = 92 * perspective;
    const shank = 88 * perspective;

    // --- Trunk rotation: leans back while cocking, then whips forward.
    const trunkLean = 20 - 52 * ramp(t, timing.trunk, 0.18);
    const hipCenter = { x: hipX, y: hipY };
    const shoulderCenter = rotate(hipCenter, torsoLength, 90 + trunkLean);

    // --- Hitting arm (right), as a swing angle measured from +x (y up):
    //     200° hanging back and low → 135° drawn up behind the head (MER)
    //     → the contact angle that produces the requested abduction.
    // Abduction is measured against the shoulder line, which points backwards
    // (right shoulder → left shoulder = -x), hence swingAngle = 180 - abduction.
    //
    // The forward swing uses a quadratic rather than a sigmoid: it reaches the
    // target angle exactly at T_CONTACT with its rate still climbing, so the
    // measured abduction at the detected contact frame is the requested one.
    const drawBack = ramp(t, 0.3, 0.4); // slow, so it never out-peaks the hips
    // The upper arm settles on the target angle a frame or two before contact
    // and holds it, so the abduction measured at the detected contact frame is
    // exactly `abductionAtContact` rather than a value caught mid-sweep.
    const swing = accelerate(t, T_MER, T_CONTACT - 0.025);
    const swingAngle =
      200 + (135 - 200) * drawBack + (180 - o.abductionAtContact - 135) * swing;

    // Elbow: nearly straight on approach, deeply cocked at MER, then extending
    // ever faster into contact. The onset of that extension is the SSC metric.
    const elbowFlexion =
      165 +
      (72 - 165) * ramp(t, 0.38, 0.34) +
      100 * accelerate(t, extensionOnsetTime, extensionEnd);

    const shoulderWidth = 44 * perspective;
    const hipWidth = 34 * perspective;

    const rightShoulder = { x: shoulderCenter.x + shoulderWidth / 2, y: shoulderCenter.y };
    const leftShoulder = { x: shoulderCenter.x - shoulderWidth / 2, y: shoulderCenter.y };
    const rightHip = { x: hipCenter.x + hipWidth / 2, y: hipCenter.y };
    const leftHip = { x: hipCenter.x - hipWidth / 2, y: hipCenter.y };

    const rightElbow = rotate(rightShoulder, upperArm, swingAngle);
    // The forearm trails the upper arm by the elbow's flexion deficit.
    const rightWrist = rotate(rightElbow, foreArm, swingAngle + (180 - elbowFlexion));

    // Non-hitting arm: a modest guiding swing, well short of the hitting arm.
    const leftArmAngle = 215 + 30 * jump;
    const leftElbow = rotate(leftShoulder, upperArm, leftArmAngle);
    const leftWrist = rotate(leftElbow, foreArm, leftArmAngle - 25);

    // Legs: loaded at the plant, extended in the air.
    const legExtension = 0.55 + 0.45 * jump;
    const rightKnee = rotate(rightHip, thigh * legExtension, 265);
    const leftKnee = rotate(leftHip, thigh * legExtension, 275);
    const rightAnkle = rotate(rightKnee, shank * legExtension, 268);
    const leftAnkle = rotate(leftKnee, shank * legExtension, 272);

    const head = rotate(shoulderCenter, 46 * perspective, 90 + trunkLean);

    const points: Record<number, { x: number; y: number }> = {
      [LM.NOSE]: head,
      [LM.LEFT_SHOULDER]: leftShoulder,
      [LM.RIGHT_SHOULDER]: rightShoulder,
      [LM.LEFT_ELBOW]: leftElbow,
      [LM.RIGHT_ELBOW]: rightElbow,
      [LM.LEFT_WRIST]: leftWrist,
      [LM.RIGHT_WRIST]: rightWrist,
      [LM.LEFT_HIP]: leftHip,
      [LM.RIGHT_HIP]: rightHip,
      [LM.LEFT_KNEE]: leftKnee,
      [LM.RIGHT_KNEE]: rightKnee,
      [LM.LEFT_ANKLE]: leftAnkle,
      [LM.RIGHT_ANKLE]: rightAnkle,
    };

    const landmarks: PoseLandmark[] = [];
    for (let index = 0; index < 33; index += 1) {
      const modelled = points[index];
      // Unmodelled landmarks (face, hands, feet) collapse onto the head and are
      // marked low-visibility, so the analysis correctly ignores them.
      const point = modelled ?? head;
      const jitter = () => (random() * 2 - 1) * o.noisePixels;
      const pixelX = point.x + jitter();
      const pixelY = point.y + jitter();
      landmarks.push({
        x: pixelX / o.width,
        y: pixelY / o.height,
        // The mock is a planar (side-on) model: z is exactly 0, which keeps the
        // constructed angles recoverable to the degree by the 3D formulas.
        z: 0,
        visibility: modelled ? 0.95 : 0.2,
        pixelX,
        pixelY,
        pixelZ: 0,
      });
    }

    // --- World landmarks: the same skeleton, re-expressed in metric space
    // with the origin re-centred on the hip midpoint, the way MediaPipe's
    // real world-landmark output is defined (types/pose.ts WorldLandmark).
    // Built from the jittered pixel landmarks above (not the clean generator
    // points) so a world-space angle and its pixel-space equivalent measure
    // the *same* noisy skeleton — an affine map (translate + uniform scale)
    // preserves angles exactly, so this is also what proves the conversion
    // does not silently distort anything.
    const hipMidPixelX = (landmarks[LM.LEFT_HIP]!.pixelX + landmarks[LM.RIGHT_HIP]!.pixelX) / 2;
    const hipMidPixelY = (landmarks[LM.LEFT_HIP]!.pixelY + landmarks[LM.RIGHT_HIP]!.pixelY) / 2;
    // Metres per pixel, derived from this frame's own (perspective-shrunk)
    // torso rather than a constant — see NOMINAL_TORSO_METERS.
    const worldScale = NOMINAL_TORSO_METERS / torsoLength;

    const worldLandmarks: WorldLandmark[] = landmarks.map((lm) => ({
      x: (lm.pixelX - hipMidPixelX) * worldScale,
      // Pixel y is already DOWN-positive and so is world y (see
      // WorldLandmark's doc comment) — no sign flip, straight rescale.
      y: (lm.pixelY - hipMidPixelY) * worldScale,
      // The mock is a planar (side-on) model: pixelZ is exactly 0 for every
      // landmark (see the comment above), so world z is 0 too. That means
      // this fixture can only exercise in-plane world-space geometry — it
      // cannot test depth-axis logic (e.g. anything that keys on the ~45°
      // passing camera angle). Whoever builds the passing mock needs a
      // genuinely non-planar skeleton for that.
      z: 0,
      visibility: lm.visibility,
    }));

    frames.push({
      index: i,
      timestampMs: (i * 1000) / o.fps,
      landmarks,
      worldLandmarks,
    });
  }

  return {
    frames,
    fps: o.fps,
    videoWidth: o.width,
    videoHeight: o.height,
    isMock: true,
  };
}
