import { describe, expect, it } from "vitest";
import { analyzePass, detectPassContactFrame } from "./passing";
import { generateMockPass, type MockPassOptions } from "./mockPass";
import { smoothSequence } from "./smoothing";
import type { PoseFrame, PoseSequence } from "../types/pose";
import type { Reading } from "../types/serveReceive";

/**
 * Contact frame index, computed the way generateMockPass computes it
 * internally — mirrors mockPass.test.ts's helper of the same name.
 */
function contactIndexFor(o: MockPassOptions): number {
  const fps = o.fps ?? 60;
  const durationSeconds = o.durationSeconds ?? 1.6;
  const contactAtFraction = o.contactAtFraction ?? 0.6;
  const frameCount = Math.max(8, Math.round(fps * durationSeconds));
  return Math.round(contactAtFraction * (frameCount - 1));
}

/**
 * A pass, as the app actually analyses one: the technique smooths before it
 * analyses (see serveReceive.ts's generateMock), and every derivative in this
 * module assumes that has happened.
 */
function passSequence(o: MockPassOptions = {}): PoseSequence {
  return smoothSequence(generateMockPass(o));
}

function readingsOf(analysis: { groups: { readings: Reading[] }[] }): Map<string, number | null> {
  return new Map(analysis.groups.flatMap((g) => g.readings).map((r) => [r.label, r.value]));
}

// ---------------------------------------------------------------------------
// Contact detection
//
// The honest summary of what this detector can and cannot do, measured against
// the fixture rather than asserted in a comment — see each block below.
// ---------------------------------------------------------------------------

describe("detectPassContactFrame — when the platform's motion is legible", () => {
  const SEEDS = [20260804, 7, 99, 1234, 555];

  it("lands within two frames of contact on a noise-free clip", () => {
    for (const seed of SEEDS) {
      const o: MockPassOptions = { seed, noiseMeters: 0 };
      const detected = detectPassContactFrame(passSequence(o).frames);
      expect(detected).not.toBeNull();
      expect(Math.abs(detected! - contactIndexFor(o))).toBeLessThanOrEqual(2);
    }
  });

  /**
   * The case the detector actually earns its place on. A platform swung
   * through the ball is both a real coaching fault and a large kinematic
   * event, so it stays legible through several millimetres of landmark
   * jitter — where a quiet platform does not (see the next block).
   */
  it("stays accurate on a swung platform through realistic jitter", () => {
    for (const noiseMeters of [0, 0.001, 0.003, 0.005]) {
      for (const seed of SEEDS) {
        const o: MockPassOptions = { seed, noiseMeters, platformSwingDegreesPerSecond: 200 };
        const detected = detectPassContactFrame(passSequence(o).frames);
        expect(detected).not.toBeNull();
        expect(Math.abs(detected! - contactIndexFor(o))).toBeLessThanOrEqual(8);
      }
    }
  });
});

/**
 * The other half of the truth, and the reason AnalyzeOptions.keyFrame exists.
 *
 * A well-played pass is nearly motionless at contact — that is the technique,
 * not a defect — so there is no impulse to find. At the fixture's default ~1cm
 * of world-landmark jitter, the noise floor of wrist acceleration measures
 * ~13 m/s^2 against a true contact signature of ~0.26 m/s^2: roughly fifty
 * times the signal, and no amount of thresholding recovers a frame from that.
 *
 * So the detector declines. That is the specified behaviour, not a shortfall —
 * "a confidently wrong contact frame is worse than none", since every reading
 * in the result is defined at or around it. These tests pin the declining,
 * because the failure that would actually hurt a coach is the detector
 * quietly starting to *guess* here.
 */
describe("detectPassContactFrame — when a quiet platform leaves nothing to find", () => {
  it("returns null rather than guessing at the fixture's default jitter", () => {
    for (const seed of [20260804, 7, 99, 1234, 555]) {
      expect(detectPassContactFrame(passSequence({ seed }).frames)).toBeNull();
    }
  });

  it("reports that as contactSource 'none', with a warning telling the coach what to do", () => {
    const analysis = analyzePass(passSequence());

    expect(analysis.contactSource).toBe("none");
    expect(analysis.contactFrame).toBeNull();
    expect(analysis.keyFrame).toBeNull();
    expect(analysis.warnings.some((w) => /mark it manually/i.test(w))).toBe(true);
  });

  it("still returns a complete, null-filled result the dashboard can render", () => {
    const analysis = analyzePass(passSequence());

    // Every reading is present and unset, rather than the groups being absent.
    const values = [...readingsOf(analysis).values()];
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v === null)).toBe(true);
    // The per-frame traces do not depend on contact, so they are still there.
    expect(analysis.series.knee.some((v) => v != null)).toBe(true);
  });

  it("declines on a clip too short to hold a pass at all", () => {
    const short = passSequence();
    short.frames = short.frames.slice(0, 4);
    expect(detectPassContactFrame(short.frames)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/**
 * With contact marked, every reading should hand back the knob the fixture was
 * built from. Run noise-free so the tolerances test the *geometry* rather than
 * the jitter — mockPass.test.ts already covers what noise does to each angle.
 */
describe("analyzePass — readings recover the fixture's knobs", () => {
  const o: MockPassOptions = {
    noiseMeters: 0,
    platformInclinationAtContact: 25,
    elbowAngleAtContact: 175,
    kneeAngleAtContact: 145,
    platformSwingDegreesPerSecond: 20,
    handSeparationMeters: 0,
  };
  const analysis = analyzePass(passSequence(o), { keyFrame: contactIndexFor(o) });
  const readings = readingsOf(analysis);

  it("recovers the platform inclination", () => {
    expect(readings.get("Platform inclination")).toBeCloseTo(25, 3);
  });

  it("recovers the elbow angle", () => {
    expect(readings.get("Elbow angle")).toBeCloseTo(175, 3);
  });

  it("recovers the knee angle", () => {
    expect(readings.get("Knee angle")).toBeCloseTo(145, 3);
  });

  it("recovers hand separation, in centimetres", () => {
    expect(readings.get("Hand separation")).toBeCloseTo(0, 3);
  });

  it("recovers the platform's angular speed through contact", () => {
    expect(readings.get("Platform angular speed")).toBeCloseTo(20, 3);
  });

  it("reads a level shoulder line as level", () => {
    expect(readings.get("Shoulder tilt")).toBeCloseTo(0, 3);
  });

  /**
   * A sign test, not a magnitude one. The platform is out in front of the
   * player, so this must be positive — an inverted body-frame `forward` would
   * report a physically impossible pass (contact behind the body) while every
   * angle beside it still looked plausible. See bodyFrame.ts's note on the
   * cross-product order and mockPass.ts's on which side gets +x.
   */
  it("puts the contact point in FRONT of the body", () => {
    expect(readings.get("Contact point (forward)")).toBeGreaterThan(0.2);
  });

  it("recovers a hand separation the fixture deliberately opens up", () => {
    const wide: MockPassOptions = { ...o, handSeparationMeters: 0.15 };
    const apart = analyzePass(passSequence(wide), { keyFrame: contactIndexFor(wide) });
    expect(readingsOf(apart).get("Hand separation")).toBeCloseTo(15, 1);
  });

  it("sees the hips rise when the fixture drives with the legs, and not when it does not", () => {
    const driven: MockPassOptions = { ...o, legDriveMeters: 0.2 };
    const flat: MockPassOptions = { ...o, legDriveMeters: 0 };
    const drivenRise = readingsOf(
      analyzePass(passSequence(driven), { keyFrame: contactIndexFor(driven) }),
    ).get("Hip rise")!;
    const flatRise = readingsOf(
      analyzePass(passSequence(flat), { keyFrame: contactIndexFor(flat) }),
    ).get("Hip rise")!;

    expect(drivenRise).toBeGreaterThan(flatRise);
    expect(flatRise).toBeCloseTo(0, 2);
  });

  it("sees the feet still moving when the fixture shuffles through contact", () => {
    // legDriveMeters: 0 isolates the shuffle — see the conflation test below.
    const still: MockPassOptions = { ...o, legDriveMeters: 0, footSpeedAtContact: 0 };
    const shuffling: MockPassOptions = { ...o, legDriveMeters: 0, footSpeedAtContact: 0.8 };
    expect(
      readingsOf(analyzePass(passSequence(still), { keyFrame: contactIndexFor(still) })).get("Foot speed"),
    ).toBeCloseTo(0, 2);
    expect(
      readingsOf(analyzePass(passSequence(shuffling), { keyFrame: contactIndexFor(shuffling) })).get(
        "Foot speed",
      ),
    ).toBeCloseTo(0.8, 1);
  });

  /**
   * A limitation of the measurement, pinned so it stays known.
   *
   * "Foot speed" answers the brief's "are the feet grounded at contact?" only
   * partly, because world landmarks are re-centred on the hip every frame (see
   * buildSeries's comment): a leg drive with the feet planted still moves the
   * ankles *relative to the hip*, and so still registers here. A coach reading
   * a small non-zero foot speed on a clip with real leg drive is not looking
   * at a shuffle-step. The two are separable in principle — the shuffle is
   * horizontal, the drive vertical — which is the obvious way to sharpen this
   * reading later; the Reading.detail text says what is measured meanwhile.
   */
  it("also registers leg drive as foot speed, feet planted (a known conflation)", () => {
    const driven: MockPassOptions = { ...o, legDriveMeters: 0.2, footSpeedAtContact: 0 };
    const speed = readingsOf(
      analyzePass(passSequence(driven), { keyFrame: contactIndexFor(driven) }),
    ).get("Foot speed")!;

    expect(speed).toBeGreaterThan(0);
  });
});

/**
 * The property the whole technique rests on: a coach's tripod is never at an
 * exact angle, so no reading may depend on where it stood. mockPass.test.ts
 * proves the *fixture* is azimuth-invariant; this proves the analysis built on
 * top of it is too, end to end, through every reading the scorecard shows.
 */
describe("analyzePass — camera-azimuth invariance", () => {
  it("produces identical readings from every camera angle", () => {
    const base: MockPassOptions = { noiseMeters: 0 };
    const keyFrame = contactIndexFor(base);
    const reference = readingsOf(
      analyzePass(passSequence({ ...base, cameraAzimuthDegrees: 0 }), { keyFrame }),
    );

    for (const cameraAzimuthDegrees of [30, 45, 60, 90, 135]) {
      const readings = readingsOf(
        analyzePass(passSequence({ ...base, cameraAzimuthDegrees }), { keyFrame }),
      );
      for (const [label, value] of reference) {
        if (value == null) {
          expect(readings.get(label)).toBeNull();
        } else {
          expect(readings.get(label)!).toBeCloseTo(value, 6);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The coach's override
// ---------------------------------------------------------------------------

describe("analyzePass — the coach's contact override", () => {
  it("takes the given frame, and records that it came from the coach", () => {
    const analysis = analyzePass(passSequence(), { keyFrame: 40 });

    expect(analysis.contactSource).toBe("manual");
    expect(analysis.contactFrame).toBe(40);
    // The shell opens the dashboard on keyFrame and rings it in the overlay,
    // so the two must not drift apart.
    expect(analysis.keyFrame).toBe(40);
  });

  it("suppresses the 'mark it manually' warning once contact is marked", () => {
    expect(analyzePass(passSequence()).warnings.some((w) => /mark it manually/i.test(w))).toBe(true);
    expect(
      analyzePass(passSequence(), { keyFrame: 40 }).warnings.some((w) => /mark it manually/i.test(w)),
    ).toBe(false);
  });

  it("actually re-reads the numbers at the marked frame", () => {
    const sequence = passSequence({ noiseMeters: 0, platformSwingDegreesPerSecond: 200 });
    const early = readingsOf(analyzePass(sequence, { keyFrame: 45 }));
    const late = readingsOf(analyzePass(sequence, { keyFrame: 57 }));

    // A platform swinging at 200 deg/s cannot present the same angle 12 frames apart.
    expect(early.get("Platform inclination")).not.toBeCloseTo(late.get("Platform inclination")!, 1);
  });

  it("does not fall over on a frame index outside the clip", () => {
    const analysis = analyzePass(passSequence(), { keyFrame: 10_000 });

    expect(analysis.contactFrame).toBe(10_000);
    expect([...readingsOf(analysis).values()].every((v) => v === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape, and never throwing
// ---------------------------------------------------------------------------

describe("analyzePass — result shape", () => {
  const sequence = passSequence();
  const analysis = analyzePass(sequence, { keyFrame: contactIndexFor({}) });

  it("tags itself as the serve-receive technique", () => {
    expect(analysis.technique).toBe("serve-receive");
  });

  it("gives every series exactly one entry per frame", () => {
    for (const [name, series] of Object.entries(analysis.series)) {
      expect(`${name}: ${series.length}`).toBe(`${name}: ${sequence.frames.length}`);
    }
  });

  it("labels every reading uniquely, so the scorecard's keys are stable", () => {
    const labels = analysis.groups.flatMap((g) => g.readings).map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("gives every reading a unit and a factual detail line", () => {
    for (const reading of analysis.groups.flatMap((g) => g.readings)) {
      expect(["°", "cm", "m", "m/s", "°/s"]).toContain(reading.unit);
      expect(reading.detail.length).toBeGreaterThan(20);
    }
  });
});

describe("analyzePass — unusable input becomes warnings, never exceptions", () => {
  it("survives an empty sequence", () => {
    const empty: PoseSequence = { frames: [], fps: 60, videoWidth: 1280, videoHeight: 720 };
    const analysis = analyzePass(empty);

    expect(analysis.contactFrame).toBeNull();
    expect(analysis.series.knee).toEqual([]);
    expect(analysis.warnings.length).toBeGreaterThan(0);
  });

  /**
   * The whole technique reads worldLandmarks; a sequence carrying only the
   * pixel track (a hand-built fixture, or a capture from before world
   * landmarks were plumbed through) must say so rather than rendering a
   * scorecard of dashes with no explanation.
   */
  it("says so plainly when the clip carries no world landmarks", () => {
    const sequence = passSequence();
    const stripped: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((f): PoseFrame => ({ ...f, worldLandmarks: undefined })),
    };
    const analysis = analyzePass(stripped);

    expect(analysis.warnings.some((w) => /no 3D world landmarks/i.test(w))).toBe(true);
    expect([...readingsOf(analysis).values()].every((v) => v === null)).toBe(true);
    expect(analysis.series.knee.every((v) => v === null)).toBe(true);
  });

  it("warns when the trunk is mostly untracked", () => {
    const sequence = passSequence();
    const patchy: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((f, i): PoseFrame => (i % 4 === 0 ? f : { ...f, worldLandmarks: [] })),
    };

    expect(analyzePass(patchy).warnings.some((w) => /fewer than 60% of frames/i.test(w))).toBe(true);
  });

  /**
   * A rolled tablet tilts every gravity-referenced angle this module computes,
   * and the geometry cannot tell that from a genuinely tilted player — so the
   * only defence is to notice a shoulder line that stays implausibly far off
   * horizontal and say so. Simulated by rolling the world landmarks about the
   * camera's view axis (z), which is exactly what holding the tablet askew
   * does.
   *
   * Filmed face-on (azimuth 0) on purpose: at 45° the shoulder line lies
   * partly *along* the roll axis, so the same 30° roll shows up as only ~21°
   * of apparent tilt and lands under the threshold. That is a property of
   * rolling a camera, not of the check — but it makes the point that this
   * warning catches a rolled tablet less readily the more obliquely the
   * player is filmed.
   */
  it("warns when the shoulder line sits far off horizontal all clip, as a rolled camera would", () => {
    const rollDegrees = 30;
    const c = Math.cos((rollDegrees * Math.PI) / 180);
    const s = Math.sin((rollDegrees * Math.PI) / 180);
    const sequence = passSequence({ noiseMeters: 0, cameraAzimuthDegrees: 0 });
    const rolled: PoseSequence = {
      ...sequence,
      frames: sequence.frames.map((f): PoseFrame => ({
        ...f,
        worldLandmarks: f.worldLandmarks?.map((w) => ({
          ...w,
          x: w.x * c - w.y * s,
          y: w.x * s + w.y * c,
        })),
      })),
    };

    expect(analyzePass(sequence).warnings.some((w) => /held level/i.test(w))).toBe(false);
    expect(analyzePass(rolled).warnings.some((w) => /held level/i.test(w))).toBe(true);
  });
});
