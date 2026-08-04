import { describe, expect, it } from "vitest";
import { defaultTechnique, isReady, TECHNIQUES } from "./index";

/**
 * The registry itself, not any one technique's biomechanics — this is the
 * contract every future `defineTechnique(...)` module has to hold up:
 * unique ids, and a default that always actually works.
 */
describe("technique registry", () => {
  it("gives every entry a unique id", () => {
    const ids = TECHNIQUES.map((technique) => technique.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns a ready technique as the default", () => {
    const technique = defaultTechnique();
    expect(isReady(technique)).toBe(true);
  });
});

/**
 * Every ready technique, walked through its own contract the way the shell
 * walks it: generate the demo clip, analyse it, ask for the transport bar's
 * jump targets. Written against the registry rather than against spike or
 * serve-receive by name, so a third technique is covered the day it is
 * registered — this is the test that catches a technique wired up with a
 * mock its own `analyze` cannot digest, which no per-technique test would.
 */
describe.each(TECHNIQUES.filter(isReady).map((t) => [t.id, t] as const))(
  "ready technique: %s",
  (_id, technique) => {
    const sequence = technique.generateMock();
    const analysis = technique.analyze(sequence);

    it("generates a mock with frames", () => {
      expect(sequence.frames.length).toBeGreaterThan(0);
    });

    it("analyses its own mock, tagged as itself", () => {
      expect(analysis.technique).toBe(technique.id);
      expect(["left", "right"]).toContain(analysis.hittingSide);
      expect(Array.isArray(analysis.warnings)).toBe(true);
    });

    it("keeps every key moment inside the clip", () => {
      for (const moment of technique.keyMoments(analysis)) {
        expect(moment.label.length).toBeGreaterThan(0);
        if (moment.frame != null) {
          expect(moment.frame).toBeGreaterThanOrEqual(0);
          expect(moment.frame).toBeLessThan(sequence.frames.length);
        }
      }
    });

    /**
     * The shell builds "Set <keyFrameLabel> here" out of this and re-runs
     * analyze with the coach's frame; a technique that ignored the override
     * would leave that button doing nothing.
     */
    it("honours the coach's key-frame override", () => {
      expect(technique.keyFrameLabel.length).toBeGreaterThan(0);

      const frame = Math.floor(sequence.frames.length / 2);
      expect(technique.analyze(sequence, { keyFrame: frame }).keyFrame).toBe(frame);
    });

    it("describes itself well enough for the picker and capture screen", () => {
      expect(technique.name.length).toBeGreaterThan(0);
      expect(technique.blurb.length).toBeGreaterThan(0);
      expect(technique.measures.length).toBeGreaterThan(0);
      expect(technique.captureHint.length).toBeGreaterThan(0);
      expect(technique.maxRecordingSeconds).toBeGreaterThan(0);
      expect(technique.maxAnalysisSeconds).toBeGreaterThanOrEqual(technique.maxRecordingSeconds);
    });
  },
);
