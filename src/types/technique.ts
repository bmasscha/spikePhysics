/**
 * technique.ts — the contract every analysable technique implements.
 *
 * The app started as a spike analyser and is growing into a technique
 * analyser: spike, serve-receive (passing), and more after that. Everything
 * that differs between techniques — the biomechanics, the coaching thresholds,
 * the cards, the charts, the filming advice — lives behind this one interface,
 * so adding a technique means adding a module and registering it, never
 * touching the stage machine, the dashboard shell or the capture screen.
 *
 * What is deliberately NOT behind the interface: pose capture, trimming,
 * MediaPipe inference, smoothing and the shared play-head. Those are the same
 * for every technique and stay in the shell.
 */

import type { ComponentType } from "react";
import type { HittingSide, PoseSequence } from "./pose";

/** Stable identifier; also what a technique is persisted/deep-linked as. */
export type TechniqueId = "spike" | "serve-receive";

/**
 * The slice of an analysis the shell itself renders — the skeleton overlay, the
 * play-head start position and the warning strip. Every technique's result
 * extends this; everything beyond it is the technique's own business and is
 * only ever read by that technique's own components.
 */
export interface BaseAnalysis {
  technique: TechniqueId;
  /**
   * Which side the analysis is anatomically mirrored off — the hitting arm for
   * a spike, the dominant/platform side for a pass. Drives the overlay
   * highlight.
   */
  hittingSide: HittingSide;
  /**
   * The moment the technique is judged on (ball contact for a spike, ball
   * contact on the platform for a pass). The dashboard opens on this frame and
   * the overlay rings it. Null when it could not be located.
   */
  keyFrame: number | null;
  /** Non-fatal issues worth surfacing to the coach. */
  warnings: string[];
}

/** A frame the dashboard offers as a one-tap jump in the transport bar. */
export interface KeyMoment {
  label: string;
  frame: number | null;
}

export interface ScorecardProps<A extends BaseAnalysis> {
  analysis: A;
}

export interface ChartsProps<A extends BaseAnalysis> {
  analysis: A;
  frameIndex: number;
  onSeekFrame: (frame: number) => void;
}

/** Everything the picker and the capture screen need, implemented status aside. */
export interface TechniqueMeta {
  id: TechniqueId;
  /** Card title, e.g. "Spike". */
  name: string;
  /** One line under the title on the picker card. */
  blurb: string;
  /** Card glyph. Emoji rather than an icon set: no asset, no license, no bytes. */
  icon: string;
  /** What this technique measures, as bullet points on the picker card. */
  measures: readonly string[];
  /** How to film it, shown on the capture screen. */
  captureHint: string;
  /** Hard cap on a recording, in seconds. */
  maxRecordingSeconds: number;
  /**
   * Longest window the analysis will process, in seconds. The cap exists so an
   * imported rally does not turn into thousands of MediaPipe inferences and a
   * locked-up tablet.
   */
  maxAnalysisSeconds: number;
}

/** A technique that can actually be analysed. */
export interface TechniqueDefinition<A extends BaseAnalysis = BaseAnalysis>
  extends TechniqueMeta {
  status: "ready";
  /** Runs the technique's biomechanics over an already-smoothed sequence. */
  analyze: (sequence: PoseSequence) => A;
  /** Synthetic sequence for the Demo clip button and for tests. */
  generateMock: () => PoseSequence;
  /** Jump targets for the dashboard transport bar, in playback order. */
  keyMoments: (analysis: A) => KeyMoment[];
  Scorecard: ComponentType<ScorecardProps<A>>;
  Charts: ComponentType<ChartsProps<A>>;
}

/** A technique that is registered but not implemented yet. */
export interface UpcomingTechnique extends TechniqueMeta {
  status: "coming-soon";
  /** Shown in place of the card's call to action. */
  note: string;
}

/**
 * A ready technique with its result type erased.
 *
 * The shell holds a technique and the analysis that technique produced as a
 * pair, and only ever hands that analysis back to that same technique's
 * components — so the concrete type is an implementation detail no caller can
 * observe. TypeScript has no existential types to express "some A", hence the
 * erasure to the base type; `defineTechnique` is the single place where it
 * happens, and it is sound precisely because the pair is never split.
 */
export type AnyTechnique = TechniqueDefinition<BaseAnalysis>;

export type TechniqueEntry = AnyTechnique | UpcomingTechnique;

/**
 * Registers a technique, checking its parts agree on one result type and then
 * erasing that type for the registry. Always define a technique through this —
 * never cast at the registry.
 */
export function defineTechnique<A extends BaseAnalysis>(
  definition: TechniqueDefinition<A>,
): AnyTechnique {
  return definition as unknown as AnyTechnique;
}

export function isReady(entry: TechniqueEntry): entry is AnyTechnique {
  return entry.status === "ready";
}
