import { z } from "zod";

import { sceneDocumentSchema } from "./envelope.js";

/**
 * Generates the JSON Schema artifact for the full scene document envelope
 * (`{ schemaVersion, project }`), using Zod's own built-in JSON Schema
 * converter (`z.toJSONSchema`, available since Zod v3.24 / the Zod 4 core).
 *
 * Every `.describe(...)` call attached to a field in `./primitives.ts`,
 * `./scene-node.ts`, `./timeline.ts`, and `./envelope.ts` flows into this
 * output as a JSON Schema `description`, so the artifact is self-describing
 * for any consumer (an agent, an editor's autocomplete, a doc generator)
 * that only has the JSON Schema file and not the Zod source.
 *
 * This is the single source of truth consumed by the package's `build`
 * script (`scripts/generate-json-schema.mjs`) to produce
 * `dist/scene.schema.json`, and by tests that validate the generated
 * artifact directly with a JSON Schema validator. Both call this same
 * function so the artifact can never drift from what the Zod schemas
 * actually accept.
 */
export function generateSceneJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(sceneDocumentSchema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
}
