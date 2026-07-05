import type { SceneNode } from "./scene-node.js";

/**
 * A composition-level transition applied as a clip comes in.
 *
 * `'cut'` (an instant switch with no blending) is deliberately not a variant
 * here: it is simply the absence of `Clip.transitionIn`, since there is
 * nothing to model for an instant cut. `direction` is only meaningful for
 * `'wipe'` (which edge the wipe sweeps in from); it must be omitted for
 * `'fade'` and `'crossDissolve'`, both of which are directionless blends.
 *
 * This type only carries the blend/progress metadata a timeline resolver
 * needs (see `resolveTransitionBlend`); actually rendering the visual effect
 * (a wipe's spatial mask, a shader-based cross-dissolve) is a future
 * renderer concern, out of scope for the timeline engine.
 */
export interface Transition {
  type: "fade" | "wipe" | "crossDissolve";
  /** How many frames the transition takes to complete, once the incoming clip starts. */
  durationInFrames: number;
  /** Which edge a `'wipe'` sweeps in from. Only meaningful (and only allowed) for `type: 'wipe'`. */
  direction?: "left" | "right" | "up" | "down";
}

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
  /**
   * Optional transition this clip blends in with, overlapping the end of
   * whichever clip precedes it on the same track (if any). Omitted means an
   * instant cut: the clip simply appears at full opacity on `startFrame`.
   */
  transitionIn?: Transition;
}

/** An ordered lane of non-overlapping-by-convention clips. */
export interface Track {
  id: string;
  /** Optional human-readable label, purely for authoring and debugging. */
  name?: string;
  clips: Clip[];
}

/**
 * Names which `CameraNode` is the active camera for a window of frames on a
 * `Composition`'s `activeCameraTrack`.
 *
 * `startFrame` and `durationInFrames` are integer frame counts with the same
 * half-open-interval convention as `Clip` (`resolveSequenceFrame` applies
 * unchanged to this shape). `cameraNodeId` is the id of a `CameraNode`
 * somewhere in this composition's resolved scene graph; resolving that id to
 * an actual camera transform/lens is a later phase's job (Phase 13's player
 * runtime), not the timeline engine's.
 */
export interface ActiveCameraEntry {
  startFrame: number;
  durationInFrames: number;
  cameraNodeId: string;
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
  /**
   * Optional, separate lane naming which camera is "active" (i.e. which the
   * renderer should actually look through) at each frame, independent of
   * `tracks`: a camera can be renderable content on a `Track` without ever
   * being the active camera, and vice versa. Omitted means this composition
   * has no active-camera concept at all (e.g. a single fixed camera, or no
   * camera-driven rendering yet).
   */
  activeCameraTrack?: ActiveCameraEntry[];
}

/** The top-level authoring unit: a named collection of compositions. */
export interface Project {
  id: string;
  name: string;
  compositions: Composition[];
}
