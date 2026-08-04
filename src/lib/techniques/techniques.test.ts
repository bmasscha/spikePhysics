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
