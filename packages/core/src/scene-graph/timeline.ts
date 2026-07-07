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
 * A linear ramp applied at the start (`fadeIn`) or end (`fadeOut`) of an
 * `AudioClip`'s own window. Just a duration: the ramp's shape (gain 0 to
 * `clip.gain` for `fadeIn`, `clip.gain` to 0 for `fadeOut`) is fixed, computed
 * by `computeGainAtLocalFrame` (see `../audio/gain-envelope.js`) rather than
 * being itself a configurable curve. A richer per-fade easing curve is a
 * reasonable future extension, not needed yet.
 */
export interface AudioFadeEnvelope {
  durationInFrames: number;
}

/**
 * A single piece of audio content placed on an `AudioTrack`.
 *
 * Mirrors `Clip`'s integer-frame, half-open-window convention:
 * `startFrame`/`durationInFrames` place this clip on the composition's
 * timeline exactly like `Clip` does, and `resolveSequenceFrame` (the same
 * helper `Clip` visibility uses) applies unchanged here too.
 *
 * `assetRef` names the source audio asset (an `AssetDescriptor.url`, or
 * whatever id scheme the asset pipeline uses); this module stays
 * environment-agnostic and never loads or decodes the referenced bytes
 * itself, matching how `ImageNode`/`MeshNode` reference assets by id/url
 * rather than embedding them.
 *
 * `trimStartFrames` (default `0`) is how many frames into the *source* audio
 * playback begins: distinct from `startFrame`, which is where the clip sits
 * on the *composition* timeline. `gain` (default `1`) is a linear multiplier
 * applied to the source audio's amplitude. `fadeIn`/`fadeOut` are optional
 * ramps at the clip's own start/end; see `computeGainAtLocalFrame` for the
 * exact ramp math and how a clip too short for its authored fade durations is
 * handled.
 */
export interface AudioClip {
  id: string;
  /** The frame, relative to the start of its composition, this clip begins on. */
  startFrame: number;
  /** How many frames this clip plays for. */
  durationInFrames: number;
  /** Identifies the source audio asset this clip plays. */
  assetRef: string;
  /** How many frames into the source audio playback begins. Defaults to `0`. */
  trimStartFrames?: number;
  /** Linear gain multiplier applied to the source audio. Defaults to `1`. */
  gain?: number;
  /** Optional ramp from silence up to `gain` at the start of this clip's window. */
  fadeIn?: AudioFadeEnvelope;
  /** Optional ramp from `gain` down to silence at the end of this clip's window. */
  fadeOut?: AudioFadeEnvelope;
}

/** An ordered lane of non-overlapping-by-convention audio clips. */
export interface AudioTrack {
  id: string;
  /** Optional human-readable label, purely for authoring and debugging. */
  name?: string;
  clips: AudioClip[];
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
  /**
   * Optional, separate lanes of audio content, independent of `tracks` (which
   * only ever carries visual scene-node content). Omitted means this
   * composition has no audio at all, matching every composition authored
   * before Phase 16. See `AudioTrack`/`AudioClip`.
   */
  audioTracks?: AudioTrack[];
  /**
   * A whole-composition color grade (exposure and white balance), applied
   * on top of this composition's own linear-light render, before tone
   * mapping. Fixed for the composition's entire length rather than
   * `Property<T>`-animatable: every other field on `Composition` itself
   * (`fps`/`width`/`height`/`durationInFrames`) is likewise a one-time
   * setting, not something that varies frame to frame. Omitted means a
   * neutral grade (0 exposure stops, 6500K/no tint white balance - a
   * no-op).
   */
  colorGrading?: CompositionColorGrading;
}

/**
 * A whole-composition color grade. See `Composition.colorGrading`'s own
 * doc for why this is a fixed, non-`Property<T>` setting.
 */
export interface CompositionColorGrading {
  /**
   * In photographic stops: each `+1` doubles the render's own brightness
   * before tone mapping, each `-1` halves it, matching a real camera's own
   * exposure compensation dial. Defaults to `0` (no adjustment).
   */
  exposureStops?: number;
  /**
   * The correlated color temperature, in Kelvin, this composition's own
   * scene illuminant is assumed to be, which the render is corrected
   * toward appearing neutral under (see `computeWhiteBalanceGain`).
   * Defaults to `6500` (standard daylight, the sRGB/D65 reference white -
   * approximately, not exactly, this correction's own true no-op point;
   * see `computeWhiteBalanceGain`'s own doc).
   */
  whiteBalanceTemperatureK?: number;
  /**
   * A green-magenta fine adjustment on top of `whiteBalanceTemperatureK`,
   * roughly `-1` (green) to `1` (magenta). Defaults to `0` (no tint
   * correction).
   */
  whiteBalanceTint?: number;
}

/** The top-level authoring unit: a named collection of compositions. */
export interface Project {
  id: string;
  name: string;
  compositions: Composition[];
}
