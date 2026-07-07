/**
 * @cadra/schema
 *
 * Zod-based scene DSL, JSON Schema generation, parser, and diagnostics for
 * the Cadra unified scene description format.
 *
 * The schemas in this package model exactly the same shape as the
 * TypeScript types in `@cadra/core`'s `scene-graph` module (`Project` down
 * to `SceneNode`), and are guarded against drifting apart from them by a
 * compile-time type-equality assertion sitting next to every major schema
 * (see the `_Check*` types in `./primitives.ts`, `./scene-node.ts`, and
 * `./timeline.ts`): if a Zod schema's inferred type ever stops matching its
 * corresponding core type, `pnpm -w typecheck` fails.
 *
 * `./keyframes.ts` mirrors `@cadra/core`'s generic keyframe/property model
 * (`Keyframe<T>`, `KeyframeTrack<T>`, `Property<T>`) the same way, guarded by
 * the same `_Check*` pattern applied to one concrete instantiation of each
 * generic schema.
 *
 * `./capabilities.ts`, `./examples.ts`, and `./describe.ts` (Phase 27) round
 * this package out into a genuinely self-describing contract: `parseScene`'s
 * diagnostics now include an `expected` and a `suggestedFix` for the common
 * error classes, and `describeCadraContract()` returns the full
 * `{ schemaVersion, jsonSchema, capabilities, examples }` contract in one
 * call, so any agent can learn the format (and self-correct a bad document)
 * at runtime with nothing more than this package.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/schema";

export type {
  CapabilityManifest,
  CodecCapability,
  EasingCapability,
  PrimitiveCapability,
} from "./capabilities.js";
export { generateCapabilityManifest } from "./capabilities.js";
export type { CadraContract } from "./describe.js";
export { describeCadraContract } from "./describe.js";
export type { SceneDocument } from "./envelope.js";
export { CURRENT_SCHEMA_VERSION, sceneDocumentSchema, schemaVersionSchema } from "./envelope.js";
export type { NamedSceneDocumentExample } from "./examples.js";
export { EXAMPLE_SCENE_DOCUMENTS } from "./examples.js";
export { generateSceneJsonSchema } from "./json-schema.js";
export { easingSchema, keyframeSchema, keyframeTrackSchema, propertySchema } from "./keyframes.js";
export type { SceneMigration } from "./migrate.js";
export { migrateSceneDocument } from "./migrate.js";
export type {
  DiagnosticCode,
  SceneDiagnosticPatch,
  SceneParseDiagnostic,
  SceneParseFailure,
  SceneParseResult,
  SceneParseSuccess,
} from "./parse.js";
export { DIAGNOSTIC_CODES, parseScene } from "./parse.js";
export type { PathSegment } from "./patch-path.js";
export { applyPatchAtPath, InvalidPathError, parsePath, PathTraversalError } from "./patch-path.js";
export { colorRgbaSchema, transformSchema, vector2Schema, vector3Schema } from "./primitives.js";
export { layerElementSchema, layerElementTypeSchema, layerStyleSchema } from "./layer-element.js";
export {
  cameraNodeSchema,
  compositionRefNodeSchema,
  groupNodeSchema,
  imageNodeSchema,
  lightNodeSchema,
  lightTypeSchema,
  meshNodeSchema,
  satoriElementKeyframesSchema,
  satoriLayerFontRefSchema,
  satoriNodeSchema,
  sceneNodeKindSchema,
  sceneNodeSchema,
  textNodeSchema,
  videoBlendModeSchema,
  videoFitModeSchema,
  videoNodeSchema,
  videoOutOfRangeBehaviorSchema,
} from "./scene-node.js";
export {
  activeCameraEntrySchema,
  audioClipSchema,
  audioFadeEnvelopeSchema,
  audioTrackSchema,
  clipSchema,
  compositionSchema,
  projectSchema,
  trackSchema,
  transitionSchema,
} from "./timeline.js";
