import type { Clip, Composition, Project, Track } from "@cadra/core";
import { z } from "zod";

import { sceneNodeSchema } from "./scene-node.js";

/**
 * Zod mirror of `Clip`, `Track`, `Composition`, and `Project` in
 * `@cadra/core`'s `scene-graph/timeline.ts`.
 *
 * `startFrame` and `durationInFrames` (on `Clip`) and `fps`, `durationInFrames`,
 * `width`, and `height` (on `Composition`) are all integer frame/pixel counts,
 * never wall-clock time or fractional pixels, consistent with the integer-frame
 * convention the Phase 3 deterministic clock model is built around. Each is
 * validated with `.int()` plus a positivity constraint appropriate to the
 * field: frame counts and dimensions must be strictly positive, `startFrame`
 * may be zero (a clip can start at the first frame of its composition) but
 * never negative.
 */

/** A compile-time-only equality check between two types, with no runtime cost. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `T` to be exactly the literal type `true`, or the file fails to typecheck. */
type AssertTrue<T extends true> = T;

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
