import type {
  ActiveCameraEntry,
  AudioClip,
  AudioFadeEnvelope,
  AudioTrack,
  Clip,
  Composition,
  Project,
  Track,
  Transition,
} from "@cadra/core";
import { z } from "zod";

import { sceneNodeSchema } from "./scene-node.js";

/**
 * Zod mirror of `Transition`, `Clip`, `Track`, `AudioFadeEnvelope`,
 * `AudioClip`, `AudioTrack`, `ActiveCameraEntry`, `Composition`, and
 * `Project` in `@cadra/core`'s `scene-graph/timeline.ts`.
 *
 * `startFrame` and `durationInFrames` (on `Clip`, `AudioClip`, and
 * `ActiveCameraEntry`), `durationInFrames` (on `Transition` and
 * `AudioFadeEnvelope`), `trimStartFrames` (on `AudioClip`), and `fps`,
 * `durationInFrames`, `width`, and `height` (on `Composition`) are all
 * integer frame/pixel counts, never wall-clock time or fractional pixels,
 * consistent with the integer-frame convention the Phase 3 deterministic
 * clock model is built around. Each is validated with `.int()` plus a
 * positivity constraint appropriate to the field: frame counts and
 * dimensions must be strictly positive, `startFrame`/`trimStartFrames` may
 * be zero but never negative.
 */

/** A compile-time-only equality check between two types, with no runtime cost. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `T` to be exactly the literal type `true`, or the file fails to typecheck. */
type AssertTrue<T extends true> = T;

/**
 * A composition-level transition applied as a clip comes in, mirroring
 * `Transition` in `@cadra/core`.
 *
 * `direction` is only meaningful for `type: 'wipe'`: `.superRefine` below
 * rejects a `'wipe'` transition missing `direction`, and rejects `direction`
 * present on a `'fade'` or `'crossDissolve'` transition, and rejects a
 * non-positive `durationInFrames` (a transition must take at least one
 * frame to have anything to blend).
 */
export const transitionSchema = z
  .strictObject({
    type: z
      .enum(["fade", "wipe", "crossDissolve"])
      .describe("Which kind of transition this is. 'cut' is the absence of a transition."),
    durationInFrames: z
      .number()
      .int()
      .positive()
      .describe("How many frames the transition takes to complete, once the incoming clip starts."),
    direction: z
      .enum(["left", "right", "up", "down"])
      .optional()
      .describe(
        "Which edge a 'wipe' sweeps in from. Only meaningful (and only allowed) for type: 'wipe'.",
      ),
  })
  .superRefine((transition, ctx) => {
    if (transition.type === "wipe" && transition.direction === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A 'wipe' transition requires a 'direction'.",
        path: ["direction"],
      });
    }
    if (transition.type !== "wipe" && transition.direction !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `'direction' is only meaningful for a 'wipe' transition, not '${transition.type}'.`,
        path: ["direction"],
      });
    }
  });

type _CheckTransition = AssertTrue<AssertEqual<z.infer<typeof transitionSchema>, Transition>>;

/**
 * A single piece of content placed on a `Track`.
 *
 * `startFrame` and `durationInFrames` are both integer frame counts, never
 * wall-clock time: the scene graph must be reproducible from frame index
 * alone.
 */
export const clipSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this clip within the project."),
  startFrame: z
    .number()
    .int()
    .min(0)
    .describe("The frame, relative to the start of its composition, this clip begins on."),
  durationInFrames: z
    .number()
    .int()
    .positive()
    .describe("How many frames this clip is visible for."),
  node: sceneNodeSchema.describe("The root of the scene-node subtree this clip contributes."),
  transitionIn: transitionSchema
    .optional()
    .describe("Optional transition this clip blends in with. Omitted means an instant cut."),
});

type _CheckClip = AssertTrue<AssertEqual<z.infer<typeof clipSchema>, Clip>>;

/** An ordered lane of non-overlapping-by-convention clips. */
export const trackSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this track within the project."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  clips: z.array(clipSchema).describe("The ordered clips placed on this track."),
});

type _CheckTrack = AssertTrue<AssertEqual<z.infer<typeof trackSchema>, Track>>;

/**
 * A linear fade ramp at the start or end of an `AudioClip`'s window,
 * mirroring `AudioFadeEnvelope` in `@cadra/core`. `durationInFrames` must be
 * a non-negative integer; whether it is *reasonable* relative to the clip it
 * belongs to (not longer than the clip's own `durationInFrames`) is enforced
 * by `audioClipSchema`'s `.superRefine` below, since a bare envelope has no
 * clip context of its own to check against.
 */
export const audioFadeEnvelopeSchema = z.strictObject({
  durationInFrames: z
    .number()
    .int()
    .min(0)
    .describe("How many frames this fade ramp takes to complete."),
});

type _CheckAudioFadeEnvelope = AssertTrue<
  AssertEqual<z.infer<typeof audioFadeEnvelopeSchema>, AudioFadeEnvelope>
>;

/**
 * A single piece of audio content placed on an `AudioTrack`, mirroring
 * `AudioClip` in `@cadra/core`. Same integer-frame, half-open-window
 * convention as `Clip`.
 *
 * `.superRefine` enforces: `gain` (when present) must be non-negative (a
 * negative amplitude multiplier has no meaningful interpretation); and each
 * of `fadeIn`/`fadeOut` (when present), individually, must not exceed this
 * clip's own `durationInFrames` (a fade literally longer than the clip it
 * belongs to is not a fade, since it would never complete). Deliberately
 * *not* enforced here: `fadeIn.durationInFrames + fadeOut.durationInFrames`
 * exceeding `durationInFrames` (the two fades overlapping) is accepted, not
 * rejected. `computeGainAtLocalFrame` in `@cadra/core` already defines
 * well-specified, sensible behavior for that case (each fade clamps to at
 * most half the clip's duration, so the two ramps meet at, but never cross,
 * the midpoint), so an author writing "fade this whole short clip in and
 * out" without doing that arithmetic themselves is intentionally supported,
 * not an error.
 */
export const audioClipSchema = z
  .strictObject({
    id: z.string().describe("Unique identifier for this clip within the project."),
    startFrame: z
      .number()
      .int()
      .min(0)
      .describe("The frame, relative to the start of its composition, this clip begins on."),
    durationInFrames: z
      .number()
      .int()
      .positive()
      .describe("How many frames this clip plays for."),
    assetRef: z.string().describe("Identifies the source audio asset this clip plays."),
    trimStartFrames: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How many frames into the source audio playback begins. Defaults to 0."),
    gain: z
      .number()
      .optional()
      .describe("Linear gain multiplier applied to the source audio. Defaults to 1."),
    fadeIn: audioFadeEnvelopeSchema
      .optional()
      .describe("Optional ramp from silence up to gain at the start of this clip's window."),
    fadeOut: audioFadeEnvelopeSchema
      .optional()
      .describe("Optional ramp from gain down to silence at the end of this clip's window."),
  })
  .superRefine((clip, ctx) => {
    if (clip.gain !== undefined && clip.gain < 0) {
      ctx.addIssue({
        code: "custom",
        message: `gain must be non-negative, got ${clip.gain}.`,
        path: ["gain"],
      });
    }
    if (clip.fadeIn !== undefined && clip.fadeIn.durationInFrames > clip.durationInFrames) {
      ctx.addIssue({
        code: "custom",
        message:
          `fadeIn.durationInFrames (${clip.fadeIn.durationInFrames}) must not exceed this ` +
          `clip's own durationInFrames (${clip.durationInFrames}).`,
        path: ["fadeIn", "durationInFrames"],
      });
    }
    if (clip.fadeOut !== undefined && clip.fadeOut.durationInFrames > clip.durationInFrames) {
      ctx.addIssue({
        code: "custom",
        message:
          `fadeOut.durationInFrames (${clip.fadeOut.durationInFrames}) must not exceed this ` +
          `clip's own durationInFrames (${clip.durationInFrames}).`,
        path: ["fadeOut", "durationInFrames"],
      });
    }
  });

type _CheckAudioClip = AssertTrue<AssertEqual<z.infer<typeof audioClipSchema>, AudioClip>>;

/** An ordered lane of non-overlapping-by-convention audio clips, mirroring `AudioTrack` in `@cadra/core`. */
export const audioTrackSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this track within the project."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  clips: z.array(audioClipSchema).describe("The ordered audio clips placed on this track."),
});

type _CheckAudioTrack = AssertTrue<AssertEqual<z.infer<typeof audioTrackSchema>, AudioTrack>>;

/**
 * Names which `CameraNode` is active for a window of frames on a
 * `Composition`'s `activeCameraTrack`, mirroring `ActiveCameraEntry` in
 * `@cadra/core`. Same integer-frame-count convention as `Clip`.
 */
export const activeCameraEntrySchema = z.strictObject({
  startFrame: z
    .number()
    .int()
    .min(0)
    .describe("The frame, relative to the start of the composition, this entry begins on."),
  durationInFrames: z
    .number()
    .int()
    .positive()
    .describe("How many frames this entry's camera stays active for."),
  cameraNodeId: z
    .string()
    .describe(
      "Id of the CameraNode active for this window, resolved elsewhere in the scene graph.",
    ),
});

type _CheckActiveCameraEntry = AssertTrue<
  AssertEqual<z.infer<typeof activeCameraEntrySchema>, ActiveCameraEntry>
>;

/**
 * A single renderable timeline: a fixed frame rate, a fixed integer duration,
 * a fixed output size, and the tracks of clips that populate it.
 */
export const compositionSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this composition within the project."),
  name: z.string().describe("Human-readable name of this composition."),
  fps: z.number().int().positive().describe("Frames per second this composition runs at."),
  durationInFrames: z
    .number()
    .int()
    .positive()
    .describe("Total integer length of this composition, in frames."),
  width: z.number().int().positive().describe("Output width of this composition, in pixels."),
  height: z.number().int().positive().describe("Output height of this composition, in pixels."),
  tracks: z.array(trackSchema).describe("The tracks of clips that populate this composition."),
  activeCameraTrack: z
    .array(activeCameraEntrySchema)
    .optional()
    .describe("Optional lane naming which camera is active at each frame, independent of tracks."),
  audioTracks: z
    .array(audioTrackSchema)
    .optional()
    .describe("Optional lanes of audio content, independent of tracks."),
});

type _CheckComposition = AssertTrue<AssertEqual<z.infer<typeof compositionSchema>, Composition>>;

/** The top-level authoring unit: a named collection of compositions. */
export const projectSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this project."),
  name: z.string().describe("Human-readable name of this project."),
  compositions: z
    .array(compositionSchema)
    .describe("The named compositions that make up this project."),
});

type _CheckProject = AssertTrue<AssertEqual<z.infer<typeof projectSchema>, Project>>;
