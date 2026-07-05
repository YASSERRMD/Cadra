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
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/schema";

export type { SceneDocument } from "./envelope.js";
export { CURRENT_SCHEMA_VERSION, sceneDocumentSchema, schemaVersionSchema } from "./envelope.js";
export { generateSceneJsonSchema } from "./json-schema.js";
export type { SceneMigration } from "./migrate.js";
export { migrateSceneDocument } from "./migrate.js";
export type {
  SceneParseDiagnostic,
  SceneParseFailure,
  SceneParseResult,
  SceneParseSuccess,
} from "./parse.js";
export { parseScene } from "./parse.js";
export { colorRgbaSchema, transformSchema, vector2Schema, vector3Schema } from "./primitives.js";
export {
  cameraNodeSchema,
  compositionRefNodeSchema,
  groupNodeSchema,
  imageNodeSchema,
  lightNodeSchema,
  lightTypeSchema,
  meshNodeSchema,
  sceneNodeKindSchema,
  sceneNodeSchema,
  textNodeSchema,
} from "./scene-node.js";
export { clipSchema, compositionSchema, projectSchema, trackSchema } from "./timeline.js";
