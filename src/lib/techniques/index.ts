/**
 * The technique registry.
 *
 * This array is the whole extension point: a new technique is a module that
 * exports a `defineTechnique(...)` value and one line added here. Nothing in
 * App.tsx, AnalysisDashboard or CameraModule knows any technique by name.
 *
 * Order matters — it is the order the picker shows the cards in.
 */

import { spikeTechnique } from "./spike";
import { serveReceiveTechnique } from "./serveReceive";
import type { AnyTechnique, TechniqueEntry, TechniqueId } from "../../types/technique";
import { isReady } from "../../types/technique";

export const TECHNIQUES: readonly TechniqueEntry[] = [
  spikeTechnique,
  serveReceiveTechnique,
];

/** What the picker pre-selects, and what a bad ?technique= falls back to. */
export const DEFAULT_TECHNIQUE_ID: TechniqueId = "spike";

export function findTechnique(id: string | null | undefined): TechniqueEntry | undefined {
  return TECHNIQUES.find((technique) => technique.id === id);
}

/**
 * The registered, implemented technique for `id`.
 * @returns undefined for an unknown id or one that is still "coming soon".
 */
export function findReadyTechnique(id: string | null | undefined): AnyTechnique | undefined {
  const entry = findTechnique(id);
  return entry && isReady(entry) ? entry : undefined;
}

/**
 * The technique the app runs when nothing has been chosen. Throws only if the
 * registry itself is broken — the default must always be implemented.
 */
export function defaultTechnique(): AnyTechnique {
  const technique = findReadyTechnique(DEFAULT_TECHNIQUE_ID);
  if (!technique) {
    throw new Error(`Default technique "${DEFAULT_TECHNIQUE_ID}" is not registered as ready`);
  }
  return technique;
}

export { isReady };
