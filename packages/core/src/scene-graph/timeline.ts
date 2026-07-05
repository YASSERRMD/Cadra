import type { SceneNode } from "./scene-node.js";

/**
 * A single piece of content placed on a `Track`.
 *
 * `startFrame` and `durationInFrames` are both integer frame counts, never
 * wall-clock time: the scene graph must be reproducible from frame index
 * alone, and "integer frames plus an explicit fps" is the one time
 * representation every later phase (deterministic clock, timeline resolver,
 * renderer) is built to consume.
 */
export interface Clip {
  id: string;
  /** The frame, relative to the start of its composition, this clip begins on. */
  startFrame: number;
  /** How many frames this clip is visible for. */
  durationInFrames: number;
  /** The root of the scene-node subtree this clip contributes to the graph. */
  node: SceneNode;
}

/** An ordered lane of non-overlapping-by-convention clips. */
export interface Track {
  id: string;
  /** Optional human-readable label, purely for authoring and debugging. */
  name?: string;
  clips: Clip[];
}

/**
 * A single renderable timeline: a fixed frame rate, a fixed integer duration,
 * a fixed output size, and the tracks of clips that populate it.
 *
 * `fps` and `durationInFrames` live here (not on `Project`) because time is
 * always relative to a specific composition: a `compositionRef` scene node
 * embeds one composition inside another, and each composition is free to run
 * at its own frame rate and length.
 */
export interface Composition {
  id: string;
  name: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  tracks: Track[];
}

/** The top-level authoring unit: a named collection of compositions. */
export interface Project {
  id: string;
  name: string;
  compositions: Composition[];
}
