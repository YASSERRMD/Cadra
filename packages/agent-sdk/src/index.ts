/**
 * @cadra/agent-sdk
 *
 * A fluent, strongly typed scene builder for programmatic and agent-driven
 * authoring of Cadra scenes: code and agents construct a scene by chaining
 * builder calls, never by hand-writing the underlying DSL JSON, and the
 * builder's terminal `.build()` always validates its own output through
 * `@cadra/schema`'s `parseScene` before returning it.
 *
 * ## Quick start
 *
 * ```ts
 * import { Camera, scene, Text } from "@cadra/agent-sdk";
 *
 * const document = scene({ id: "proj-1", name: "My Project" })
 *   .composition({ id: "comp-1", name: "Main", fps: 30, durationInFrames: 90, size: { width: 1920, height: 1080 } })
 *   .add(
 *     Text({ id: "title", content: "Hello, Cadra" })
 *       .animate({ color: [{ frame: 0, value: [1, 1, 1, 0] }, { frame: 15, value: [1, 1, 1, 1] }] })
 *       .at(0, 60),
 *   )
 *   .add(
 *     Camera({ id: "cam-1", fov: 50 })
 *       .animateTransform({
 *         position: [
 *           { frame: 0, value: [0, 0, 10] },
 *           { frame: 90, value: [0, 0, 5] },
 *         ],
 *       })
 *       .at(0, 90),
 *   )
 *   .build();
 * // document: { schemaVersion: 1, project: Project }, guaranteed to have
 * // already passed parseScene.
 * ```
 *
 * If the assembled document would fail schema validation, `.build()` throws
 * `SceneBuildError` instead, carrying the exact `SceneParseDiagnostic[]`
 * `parseScene` produced:
 *
 * ```ts
 * import { scene, SceneBuildError } from "@cadra/agent-sdk";
 *
 * try {
 *   scene({ id: "p", name: "Empty is fine, but a bad clip range is not" })
 *     .composition({ id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 })
 *     .build();
 * } catch (error) {
 *   if (error instanceof SceneBuildError) {
 *     for (const diagnostic of error.diagnostics) {
 *       console.error(`${diagnostic.path}: ${diagnostic.message}`);
 *     }
 *   }
 * }
 * ```
 *
 * A structurally impossible request (e.g. a negative or non-integer frame
 * range passed to `.at()`) instead throws `SceneBuilderUsageError`
 * immediately at the call site, before a document is even assembled.
 *
 * ## Every primitive is reachable from the builder
 *
 * `Text`, `Image`, `Shape`, `Camera`, and `Light` are builder-flavored
 * mirrors of the Phase 7 primitive factories of the same name in
 * `@cadra/core`: same `Props` shape and defaults, wrapped in a `NodeBuilder`
 * so the result chains into `.animate()`/`.animateTransform()`/`.at()`.
 * `Sequence` and `Series` are re-exported from `@cadra/core` unchanged, since
 * they already produce a `Clip`/`Clip[]` directly (frame timing baked in),
 * not a bare `SceneNode` needing `.at()`:
 *
 * ```ts
 * import { scene, Sequence, Shape, Text } from "@cadra/agent-sdk";
 *
 * const composition = scene({ id: "p", name: "P" }).composition({
 *   id: "c",
 *   name: "Main",
 *   fps: 30,
 *   durationInFrames: 60,
 *   size: { width: 1280, height: 720 },
 * });
 *
 * composition.add(
 *   Sequence({
 *     id: "intro",
 *     from: 0,
 *     durationInFrames: 30,
 *     content: [Shape({ id: "box" }).node, Text({ id: "label", content: "Box" }).node],
 *   }),
 * );
 * ```
 *
 * ## Which properties are genuinely animatable
 *
 * `.animateTransform()` accepts `position`/`rotation`/`scale` for every node
 * kind. `.animateVisible()` accepts a boolean keyframe track for every node
 * kind (author each keyframe but the last with `easing: 'hold'`, since a
 * boolean has no continuous blend). `.animate()` additionally accepts, per
 * node kind, exactly the fields `@cadra/core`'s
 * `primitives/animatable-properties.ts` documents as animatable:
 * `camera`'s `fov`/`near`/`far`/`target`, `light`'s `color`/`intensity`, and
 * `text`'s `color`/`fontSize`. Animating a field a given node kind does not
 * support (e.g. `fontSize` on a `Shape`) is a compile error, not a silently
 * ignored call.
 */

export type { Addable, CompositionBuilderProps, CompositionSize } from "./composition-builder.js";
export { CompositionBuilder } from "./composition-builder.js";
export { SceneBuildError, SceneBuilderUsageError } from "./errors.js";
export type { AnimateInput } from "./keyframe-input.js";
export type {
  AnimationPatchFor,
  AtOptions,
  ClipPlacement,
  TransformAnimationPatch,
  VisibleAnimationInput,
} from "./node-builder.js";
export { NodeBuilder } from "./node-builder.js";
export { Camera, Image, Light, Shape, Text } from "./primitives.js";
export { scene, SceneBuilder, type SceneBuilderProps } from "./scene-builder.js";
export type {
  SequenceFrameResolution,
  SequenceProps,
  SequenceWindow,
  SeriesEntry,
} from "@cadra/core";
export {
  CAMERA_ANIMATABLE_PROPERTIES,
  deriveSequenceRootId,
  IMAGE_ANIMATABLE_PROPERTIES,
  LIGHT_ANIMATABLE_PROPERTIES,
  resolveSequenceFrame,
  Sequence,
  Series,
  SHAPE_ANIMATABLE_PROPERTIES,
  TEXT_ANIMATABLE_PROPERTIES,
} from "@cadra/core";

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/agent-sdk";
