/**
 * mockPass.ts — synthetic serve-receive (passing) generator.
 *
 * Same job as mockData.ts (§7.1): produce a physically plausible pose sequence
 * with a *known* correct answer, so the passing analysis can be built and
 * tested with no camera, no MediaPipe and no model file.
 *
 * The critical difference from the spike mock: the spike is filmed side-on, so
 * building pixel coordinates directly (with z pinned to 0) is enough — the
 * whole swing lives in the image plane. Serve-receive is filmed at ~45° to the
 * player (see the note on WorldLandmark in types/pose.ts and the header of
 * bodyFrame.ts), so a planar fixture cannot exercise anything about the camera
 * angle, which is the entire difficulty of passing. This generator is built
 * the other way round:
 *
 *   1. Construct the skeleton in metric 3D, in a canonical body-centred frame:
 *      hips at the origin, a fixed set of local axes (x = the player's own
 *      lateral direction, y = DOWN, z = the direction the platform faces),
 *      driven forward-kinematically from the knobs below. Nothing here knows
 *      where the camera is yet.
 *   2. Rotate the whole scene about the vertical (y) axis by
 *      `cameraAzimuthDegrees` — this is what "places the camera". The same
 *      rotation is used by bodyFrame.test.ts's azimuth-invariance check, so a
 *      pass generated at 0°, 30°, 45° or 60° is the *same physical pose*, just
 *      re-shot from a different angle, exactly the scenario bodyFrame.ts
 *      exists to be invariant to.
 *   3. Emit `worldLandmarks` from that rotated metric scene, and derive the
 *      pixel landmarks from it by a simple weak-perspective (constant-scale)
 *      projection: pixelX/Y/Z all share one metres-to-pixels factor, so the
 *      pixel track is an isotropic similarity image of the world track and an
 *      angle computed from either agrees with the other exactly.
 *
 * Every knob below is a quantity the passing analysis will eventually have to
 * *recover* from the generated landmarks, the way `elbowOnsetRatio` is for the
 * spike — see mockPass.test.ts for what "recover" means precisely and to what
 * tolerance.
 */

import { LM } from "./landmarks";
import { mulberry32 } from "./mockData";
import {
  add,
  clamp,
  degToRad,
  radToDeg,
  scale,
  type Vec3,
} from "./vectorMath";
import type { PoseLandmark, PoseFrame, PoseSequence, WorldLandmark } from "../types/pose";

// ---------------------------------------------------------------------------
// MediaPipe indices not carried by landmarks.ts
// ---------------------------------------------------------------------------

// LM (landmarks.ts) only names the joints the spike needs. Passing's footwork
// (the `footSpeedAtContact` knob) needs the heel and toe too, so they are
// referenced here by their raw MediaPipe Pose index — see the 33-point layout
// at https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker.
const LEFT_HEEL = 29;
const RIGHT_HEEL = 30;
const LEFT_FOOT_INDEX = 31;
const RIGHT_FOOT_INDEX = 32;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MockPassOptions {
  fps?: number;
  durationSeconds?: number;
  width?: number;
  height?: number;
  seed?: number;
  /** Std-dev-ish (uniform) jitter applied to every *world* landmark, in metres. */
  noiseMeters?: number;
  /**
   * Where the camera sits relative to the player, as a rotation about the
   * vertical axis, in degrees. 0° is face-on, 90° would be the spike's side-on
   * shot; ~45° is the brief for serve-receive. This is the knob the whole
   * generator exists to exercise: every body-relative measurement the analysis
   * takes must come out identical regardless of this value (see the
   * "azimuth invariance" tests) — a real coach's tripod is never at an exact
   * angle, so an analysis that is *not* invariant to this is not usable.
   */
  cameraAzimuthDegrees?: number;
  /**
   * Angle of the forearm line above horizontal at the contact frame, in
   * degrees. This is the "platform angle" a receiver presents to the ball —
   * too flat sends it long, too steep sends it straight up. Measured against
   * true horizontal (gravity), not the player's own lean, exactly like
   * `angleFromHorizontal` in bodyFrame.ts.
   */
  platformInclinationAtContact?: number;
  /** Elbow angle at contact, degrees. 180 = dead straight; lower = bent. */
  elbowAngleAtContact?: number;
  /** Knee angle at contact, degrees. 180 = standing tall; lower = loaded/bent. */
  kneeAngleAtContact?: number;
  /**
   * How far the hips rise through the leg-drive into contact, in metres.
   * 0 = no leg drive. Note what this can and can't mean in MediaPipe's own
   * coordinate system: world landmarks are always re-centred on the hip
   * midpoint (see WorldLandmark's doc comment and the origin test below), so
   * the hip itself can never appear to move — a real leg drive with the feet
   * planted shows up as *everything else* (ankles, knees) receding further
   * from the hip as the hip rises away from the ground. That is exactly how
   * this knob is implemented and exactly how a real MediaPipe capture of a
   * leg drive would look in world space, not a limitation of the mock.
   */
  legDriveMeters?: number;
  /**
   * Angular speed of the platform's swing through contact, degrees/second.
   * ~0 is a quiet, still platform (a "push" pass — good technique); a large
   * value is an arm swing carried through the ball (a common fault). This is
   * the rate of change of the *same* forearm-inclination angle that
   * `platformInclinationAtContact` fixes the value of at the contact instant —
   * one knob sets the angle, the other sets how fast it was moving through
   * that angle.
   */
  platformSwingDegreesPerSecond?: number;
  /**
   * Metres/second the feet are still travelling at the contact frame. 0 means
   * grounded and set (good technique); a shuffle-step still in progress at
   * contact is worse technique and shows up as ankle/heel/toe speed instead of
   * a change in the hip, for the same hip-is-always-the-origin reason
   * documented on `legDriveMeters`.
   */
  footSpeedAtContact?: number;
  /**
   * Lateral distance between the two wrists at contact, in metres. 0 = hands
   * locked together (the technique goal); larger = the platform coming apart.
   */
  handSeparationMeters?: number;
  /** Fraction of the clip at which contact occurs. */
  contactAtFraction?: number;
}

const DEFAULTS: Required<MockPassOptions> = {
  // A receive's platform swing through contact can be as brief as ~150-250ms;
  // 30fps would resolve that into only 5-8 samples, too coarse to recover
  // platformSwingDegreesPerSecond precisely by finite difference. 60fps
  // mirrors the spike mock's reasoning (see mockData.ts DEFAULTS).
  fps: 60,
  durationSeconds: 1.6,
  width: 1280,
  height: 720,
  seed: 20260804,
  // ~1cm of per-landmark jitter: a plausible order of magnitude for a
  // monocular world-landmark estimate (see WorldLandmark's doc comment on
  // depth being "the weakest of the three axes"), small enough that the
  // contact-frame angle tests below still resolve comfortably inside their
  // stated tolerances.
  noiseMeters: 0.01,
  cameraAzimuthDegrees: 45,
  // A flat-ish, slightly-upward platform aimed at a target above the net.
  platformInclinationAtContact: 25,
  // Built at 175°, i.e. very slightly short of dead straight — a demo clip
  // that reads as good, but not physically perfect, technique.
  elbowAngleAtContact: 175,
  // A loaded, athletic receiving stance, not standing tall.
  kneeAngleAtContact: 145,
  // A modest leg-drive push through the ball (passing is not a jump).
  legDriveMeters: 0.05,
  // Good technique: a quiet platform, not a big swing.
  platformSwingDegreesPerSecond: 20,
  // Good technique: grounded and set at contact.
  footSpeedAtContact: 0,
  // Good technique: hands together.
  handSeparationMeters: 0,
  contactAtFraction: 0.6,
};

// ---------------------------------------------------------------------------
// Skeleton constants (metres)
// ---------------------------------------------------------------------------

// Adult-figure bone lengths. TORSO_LEN deliberately matches mockData.ts's
// NOMINAL_TORSO_METERS (0.5m) so the two mocks agree on the same "reasonable
// adult" scale.
const TORSO_LEN = 0.5;
const SHOULDER_WIDTH = 0.38;
const HIP_WIDTH = 0.28;
const UPPER_ARM_LEN = 0.28;
const FOREARM_LEN = 0.25;
const THIGH_LEN = 0.42;
const SHANK_LEN = 0.42;
const HEAD_OFFSET = 0.22;
// Heel/toe sit slightly below and behind/ahead of the ankle joint itself.
const FOOT_DROP = 0.04;
const HEEL_BACK = 0.06;
const TOE_FORWARD = 0.18;

// Projection: a single isotropic metres->pixels factor and a fixed screen
// anchor for the hip midpoint. See the header comment: this is a weak
// (orthographic) perspective — one constant scale for the whole figure rather
// than a per-landmark depth divide — which is the simple, documented
// projection the brief asks for. It keeps the map from world to pixel space a
// pure similarity transform (translate + uniform scale), which is exactly
// what the pixel/world consistency test relies on.
const PIXELS_PER_METER = 300;
const ANCHOR_X_FRACTION = 0.5;
const ANCHOR_Y_FRACTION = 0.62;

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

/** Smooth 0→1 ramp centred on `center`, reaching ~full value over `width`. Same shape as mockData.ts's `ramp`. */
function ramp(t: number, center: number, width: number): number {
  return 1 / (1 + Math.exp(-(t - center) / (width / 6)));
}

/**
 * Unit direction for a limb segment measured as an *inclination above
 * horizontal*: 0° points straight along local +z (forward, horizontal), and
 * positive angles tilt it toward -y (up). Used for the arm/platform, whose
 * defining angle (`platformInclinationAtContact`) is naturally horizontal-vs-
 * vertical, matching bodyFrame.ts's `angleFromHorizontal` convention exactly
 * (x is left 0 here so the two agree beyond floating-point noise).
 */
function directionFromHorizontal(inclinationDeg: number): Vec3 {
  const r = degToRad(inclinationDeg);
  return { x: 0, y: -Math.sin(r), z: Math.cos(r) };
}

/**
 * Unit direction for a limb segment measured as an angle *from straight down*:
 * 0° points along local +y (straight down, i.e. hanging), and positive angles
 * swing it toward +z. Used for the leg, whose defining angle (knee flexion) is
 * naturally "how far off dead-straight-down" rather than "how far off
 * horizontal".
 */
function directionFromVertical(angleDeg: number): Vec3 {
  const r = degToRad(angleDeg);
  return { x: 0, y: Math.cos(r), z: Math.sin(r) };
}

/**
 * Rotates a point about the world vertical axis (y), by `degrees`, about the
 * origin. This single function does double duty in this file: applied to the
 * whole scene it *is* `cameraAzimuthDegrees` (re-shooting from a different
 * angle); applied to just one arm's elbow+wrist about their shared shoulder it
 * yaws that arm inward for `handSeparationMeters`. Both uses rely on the same
 * two facts about a rotation about y: it leaves the y component untouched
 * (so it can never disturb an angle-from-horizontal measurement) and it is a
 * rigid transform (so it can never disturb an interior joint angle measured
 * among points that are rotated together). Matches the convention fixed by
 * bodyFrame.test.ts's `rotateAroundY` exactly, which is what the azimuth
 * invariance tests below rely on to describe the same rotation.
 */
function rotateY(v: Vec3, degrees: number): Vec3 {
  const r = degToRad(degrees);
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: v.x * cos + v.z * sin, y: v.y, z: -v.x * sin + v.z * cos };
}

/**
 * Builds one leg (hip, knee, ankle, heel, foot-index) in the canonical local
 * frame, hip already at the correct lateral offset from the body midline.
 *
 * The knee's *interior* angle (angleAt(knee, hip, ankle)) comes out equal to
 * `kneeAngleDeg` exactly, for any bone lengths: the thigh points straight down
 * (angle 0 from vertical) and the shank is built at `180 - kneeAngleDeg` off
 * that same reference, so the angle *between* the two segments — which is all
 * `angleAt` measures — is exactly `kneeAngleDeg` regardless of `shankLen`.
 * That independence is what lets `legDriveMeters` stretch the shank's
 * *length* (simulating the hip rising away from a planted foot) without
 * perturbing the knee angle the analysis is separately trying to recover —
 * see `legDriveMeters`'s own doc comment for why length, not the hip's
 * position, is the only thing available to carry that signal.
 */
function buildLeg(params: {
  sideSign: 1 | -1;
  effectiveShankLen: number;
  kneeAngleDeg: number;
  footShuffleZ: number;
}): { hip: Vec3; knee: Vec3; ankle: Vec3; heel: Vec3; footIndex: Vec3 } {
  const { sideSign, effectiveShankLen, kneeAngleDeg, footShuffleZ } = params;
  const hip: Vec3 = { x: (sideSign * HIP_WIDTH) / 2, y: 0, z: 0 };
  const knee = add(hip, scale(directionFromVertical(0), THIGH_LEN));
  const shankAngle = 180 - kneeAngleDeg;
  const ankleBase = add(knee, scale(directionFromVertical(shankAngle), effectiveShankLen));
  // The shuffle-step (footSpeedAtContact) displaces the whole foot forward or
  // back; it is not a bend at any joint, so it is added after the rigid leg
  // is built rather than folded into an angle.
  const ankle: Vec3 = { x: ankleBase.x, y: ankleBase.y, z: ankleBase.z + footShuffleZ };
  const heel: Vec3 = { x: ankle.x, y: ankle.y + FOOT_DROP, z: ankle.z - HEEL_BACK };
  const footIndex: Vec3 = { x: ankle.x, y: ankle.y + FOOT_DROP, z: ankle.z + TOE_FORWARD };
  return { hip, knee, ankle, heel, footIndex };
}

/**
 * Builds one arm (shoulder, elbow, wrist) in the canonical local frame.
 *
 * The forearm's own inclination-from-horizontal comes out equal to
 * `platformAngleDeg` exactly (by the same "measure the angle from a fixed
 * zero" trick as `buildLeg`'s knee), and the elbow's interior angle comes out
 * equal to `elbowAngleDeg` exactly, for the same reason. Both of those are
 * true of the *unyawed* (purely sagittal, x=0) arm built first; the inward
 * yaw that brings the wrist to `handSeparationMeters` is then applied to the
 * elbow and wrist together, about an axis through the shoulder — a rigid
 * rotation of the pair, which by construction cannot change the angle between
 * them (the elbow angle) and, being a rotation about the vertical axis,
 * cannot change the forearm's y component or its horizontal-plane distance
 * either (see `rotateY`), so the inclination survives the yaw exactly too.
 */
function buildArm(params: {
  sideSign: 1 | -1;
  elbowAngleDeg: number;
  platformAngleDeg: number;
  handSeparationMeters: number;
}): { shoulder: Vec3; elbow: Vec3; wrist: Vec3 } {
  const { sideSign, elbowAngleDeg, platformAngleDeg, handSeparationMeters } = params;
  const shoulder: Vec3 = { x: (sideSign * SHOULDER_WIDTH) / 2, y: -TORSO_LEN, z: 0 };

  // Forearm is pinned directly to the requested platform angle. Upper arm is
  // *derived* from it and the elbow angle (upperArm = forearm - elbow
  // deficit), the same "trailing segment" construction mockData.ts uses for
  // the hitting arm's elbow (see its comment on `rightWrist`).
  const upperArmAngle = platformAngleDeg - (180 - elbowAngleDeg);
  const elbowRel = scale(directionFromHorizontal(upperArmAngle), UPPER_ARM_LEN);
  const forearmRel = scale(directionFromHorizontal(platformAngleDeg), FOREARM_LEN);
  const wristRel = add(elbowRel, forearmRel);

  // Solve the inward yaw that lands the wrist at the requested lateral offset
  // from the body midline. wristRel.x is 0 before the yaw (the arm is built
  // purely in the sagittal x=0 plane above), and a rotation about y moves x by
  // exactly `wristRel.z * sin(yaw)` (see rotateY) — so this is a one-line
  // inverse, not a search.
  //
  // KNOWN LIMITATION: when the forearm is steep (platformAngleDeg close to
  // ±90°) wristRel.z shrinks toward 0, so a large handSeparationMeters can
  // demand more yaw than is geometrically available; the ratio is clamped to
  // [-1, 1] rather than left to blow up, which means handSeparationMeters is
  // *not* independent of platformInclinationAtContact at extreme combinations
  // of the two. At the defaults, and anywhere near them, this never engages.
  const targetWristX = (sideSign * handSeparationMeters) / 2;
  const safeZ = Math.abs(wristRel.z) < 1e-6 ? (wristRel.z >= 0 ? 1e-6 : -1e-6) : wristRel.z;
  const ratio = clamp((targetWristX - shoulder.x) / safeZ, -1, 1);
  const yawDegrees = radToDeg(Math.asin(ratio));

  const elbow = add(shoulder, rotateY(elbowRel, yawDegrees));
  const wrist = add(shoulder, rotateY(wristRel, yawDegrees));
  return { shoulder, elbow, wrist };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function generateMockPass(options: MockPassOptions = {}): PoseSequence {
  const o = { ...DEFAULTS, ...options };
  const random = mulberry32(o.seed);
  const frameCount = Math.max(8, Math.round(o.fps * o.durationSeconds));

  // Contact is pinned to an exact frame (not interpolated between two), so
  // the "recoverable at contact" tests can read that frame directly and get
  // the requested values back with no discretization error of their own —
  // only the noise contributes error, and that is what the tests' tolerances
  // are sized for.
  const contactIndex = Math.round(o.contactAtFraction * (frameCount - 1));
  const contactSeconds = contactIndex / o.fps;

  // Half-width, in seconds, of the window around contact over which the
  // platform swing and the foot shuffle are modelled as exactly linear (see
  // below). Clamped so it always fits inside a short clip.
  const swingWindowSeconds = Math.min(0.15, o.durationSeconds / 4);
  const footWindowSeconds = Math.min(0.1, o.durationSeconds / 4);

  // Leg-drive loading: knee/ankle geometry ramps from "loaded" toward "driven"
  // as contact approaches, reaching fully driven (riseProfile = 1) at contact.
  const riseCenter = clamp(o.contactAtFraction - 0.1, 0.05, 0.95);
  const riseWidth = 0.3;

  const frames: PoseFrame[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    const t = i / (frameCount - 1); // normalized [0,1], for slow-shape ramps
    const tSeconds = i / o.fps; // real seconds, for the rate-exact ramps below

    // --- Platform inclination: a straight line through the contact instant,
    // clamped outside a small window. Inside the window its slope is exactly
    // `platformSwingDegreesPerSecond` (degrees/second, by construction), and
    // at tSeconds === contactSeconds it evaluates to exactly
    // `platformInclinationAtContact` — both recoverable to floating-point
    // precision before noise, which is exactly what the "shows up as motion"
    // and "recoverable at contact" tests check.
    const swingOffset = clamp(tSeconds - contactSeconds, -swingWindowSeconds, swingWindowSeconds);
    const platformAngleDeg = o.platformInclinationAtContact + o.platformSwingDegreesPerSecond * swingOffset;

    // --- Foot shuffle: the same clamped-linear trick, this time for a
    // position (metres) rather than an angle, so its derivative at contact is
    // exactly `footSpeedAtContact`.
    const footOffset = clamp(tSeconds - contactSeconds, -footWindowSeconds, footWindowSeconds);
    const footShuffleZ = o.footSpeedAtContact * footOffset;

    // --- Leg drive: the shank "grows" toward contact (see buildLeg's comment
    // on why length, not the hip's position, carries this signal).
    const riseProfile = ramp(t, riseCenter, riseWidth);
    const effectiveShankLen = SHANK_LEN + o.legDriveMeters * riseProfile;

    // Which side gets +x is NOT arbitrary, and getting it backwards is
    // invisible in every angle: it only shows up in body-frame *signs*.
    //
    // This file builds the figure facing local +z (see directionFromHorizontal:
    // the platform, the toes and the shuffle-step all extend that way).
    // bodyFrame.ts derives "forward" as cross(up, lateral) with lateral running
    // LEFT_HIP -> RIGHT_HIP, so for that derived forward to come out as +z —
    // agreeing with the direction this file actually points the limbs — the
    // player's RIGHT must sit at +x and their LEFT at -x. Work it through with
    // up = (0, -1, 0) (world y is DOWN): lateral = (+1, 0, 0) gives
    // cross(up, lateral) = (0, 0, +1). The opposite assignment yields
    // forward = (0, 0, -1), which reads the platform as being 45cm *behind* the
    // player — a fixture describing a physically impossible pass.
    const leftLeg = buildLeg({
      sideSign: -1,
      effectiveShankLen,
      kneeAngleDeg: o.kneeAngleAtContact,
      footShuffleZ,
    });
    const rightLeg = buildLeg({
      sideSign: 1,
      effectiveShankLen,
      kneeAngleDeg: o.kneeAngleAtContact,
      footShuffleZ,
    });
    const leftArm = buildArm({
      sideSign: -1,
      elbowAngleDeg: o.elbowAngleAtContact,
      platformAngleDeg,
      handSeparationMeters: o.handSeparationMeters,
    });
    const rightArm = buildArm({
      sideSign: 1,
      elbowAngleDeg: o.elbowAngleAtContact,
      platformAngleDeg,
      handSeparationMeters: o.handSeparationMeters,
    });

    const shoulderMid: Vec3 = {
      x: (leftArm.shoulder.x + rightArm.shoulder.x) / 2,
      y: (leftArm.shoulder.y + rightArm.shoulder.y) / 2,
      z: (leftArm.shoulder.z + rightArm.shoulder.z) / 2,
    };
    const head = add(shoulderMid, { x: 0, y: -HEAD_OFFSET, z: 0 });

    // Local (pre-rotation, pre-noise) points for every modelled landmark.
    // Everything else (face, fingers) collapses onto the head point, exactly
    // as mockData.ts does, and gets marked low-visibility below so the
    // analysis knows to ignore it.
    const modelled: Partial<Record<number, Vec3>> = {
      [LM.NOSE]: head,
      [LM.LEFT_SHOULDER]: leftArm.shoulder,
      [LM.RIGHT_SHOULDER]: rightArm.shoulder,
      [LM.LEFT_ELBOW]: leftArm.elbow,
      [LM.RIGHT_ELBOW]: rightArm.elbow,
      [LM.LEFT_WRIST]: leftArm.wrist,
      [LM.RIGHT_WRIST]: rightArm.wrist,
      [LM.LEFT_HIP]: leftLeg.hip,
      [LM.RIGHT_HIP]: rightLeg.hip,
      [LM.LEFT_KNEE]: leftLeg.knee,
      [LM.RIGHT_KNEE]: rightLeg.knee,
      [LM.LEFT_ANKLE]: leftLeg.ankle,
      [LM.RIGHT_ANKLE]: rightLeg.ankle,
      [LEFT_HEEL]: leftLeg.heel,
      [RIGHT_HEEL]: rightLeg.heel,
      [LEFT_FOOT_INDEX]: leftLeg.footIndex,
      [RIGHT_FOOT_INDEX]: rightLeg.footIndex,
    };

    // --- Place the camera: rotate the whole local scene about the vertical
    // axis. This is the single line that turns a canonical, camera-agnostic
    // body pose into "what a camera standing at cameraAzimuthDegrees would
    // see" — see the header comment and rotateY's doc comment.
    const rotated: Vec3[] = [];
    for (let index = 0; index < 33; index += 1) {
      const local = modelled[index] ?? head;
      rotated.push(rotateY(local, o.cameraAzimuthDegrees));
    }

    // --- Metric-space jitter, applied per landmark per axis after the camera
    // rotation (see noiseMeters's doc comment: this models noise in the
    // vision system's world-space estimate, which does not rotate with the
    // camera — it is a property of the estimator, not the physical body).
    const jitter = () => (random() * 2 - 1) * o.noiseMeters;
    const noisy: Vec3[] = rotated.map((p) => ({
      x: p.x + jitter(),
      y: p.y + jitter(),
      z: p.z + jitter(),
    }));

    // --- Re-centre on the (noisy) hip midpoint so it lands EXACTLY at the
    // origin regardless of noise, matching MediaPipe's own definition of
    // world-landmark space and mockData.ts's identical trick for the same
    // property. A uniform translation applied to every landmark cannot change
    // any angle or relative distance, so this adds no error to the
    // recoverability tests beyond the noise already present.
    const hipMid: Vec3 = {
      x: (noisy[LM.LEFT_HIP]!.x + noisy[LM.RIGHT_HIP]!.x) / 2,
      y: (noisy[LM.LEFT_HIP]!.y + noisy[LM.RIGHT_HIP]!.y) / 2,
      z: (noisy[LM.LEFT_HIP]!.z + noisy[LM.RIGHT_HIP]!.z) / 2,
    };

    const worldLandmarks: WorldLandmark[] = [];
    const landmarks: PoseLandmark[] = [];
    const anchorX = o.width * ANCHOR_X_FRACTION;
    const anchorY = o.height * ANCHOR_Y_FRACTION;

    for (let index = 0; index < 33; index += 1) {
      const visibility = modelled[index] ? 0.95 : 0.2;
      const worldX = noisy[index]!.x - hipMid.x;
      const worldY = noisy[index]!.y - hipMid.y;
      const worldZ = noisy[index]!.z - hipMid.z;
      worldLandmarks.push({ x: worldX, y: worldY, z: worldZ, visibility });

      // Weak-perspective projection (see PIXELS_PER_METER's comment): one
      // constant metres->pixels factor for x, y AND z, so pixelZ stays on the
      // same isotropic scale as pixelX/pixelY exactly as PoseLandmark.pixelZ
      // documents, and the pixel track is a pure similarity image of the
      // world track (translate + uniform scale — angle-preserving).
      const pixelX = anchorX + worldX * PIXELS_PER_METER;
      const pixelY = anchorY + worldY * PIXELS_PER_METER;
      const pixelZ = worldZ * PIXELS_PER_METER;
      landmarks.push({
        x: pixelX / o.width,
        y: pixelY / o.height,
        z: pixelZ / o.width,
        visibility,
        pixelX,
        pixelY,
        pixelZ,
      });
    }

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
