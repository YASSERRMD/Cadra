import { z } from "zod";

import { sceneDocumentSchema } from "./envelope.js";

type JsonSchemaNode = Record<string, unknown>;

function isJsonSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One `{ required: [name] }` branch per name, combined with `anyOf` - the JSON Schema shape of "at least one of these fields is present". */
function requireAtLeastOneOf(...fieldNames: string[]): JsonSchemaNode {
  return { anyOf: fieldNames.map((fieldName) => ({ required: [fieldName] })) };
}

/**
 * Finds every object-schema node, anywhere in `root`, whose `properties.kind`
 * is the literal `"mesh"` - i.e. the JSON Schema translation of
 * `meshNodeSchema` wherever it was inlined (`z.toJSONSchema` factors a
 * schema out into `$defs` and `$ref`s it only when the same schema instance
 * is reachable from more than one place, so `meshNodeSchema`'s exact
 * location among `$defs`/`oneOf`/`anyOf` branches is not a stable path to
 * hardcode). A structural search by discriminant, mirroring `./parse.ts`'s
 * `checkAssetRefs` walk, stays correct regardless of how `zod` happens to
 * lay the tree out.
 */
function findMeshNodeSchemas(value: unknown): JsonSchemaNode[] {
  if (Array.isArray(value)) {
    return value.flatMap(findMeshNodeSchemas);
  }
  if (!isJsonSchemaNode(value)) {
    return [];
  }
  const properties = value.properties;
  const isMeshNode =
    isJsonSchemaNode(properties) && isJsonSchemaNode(properties.kind) && properties.kind.const === "mesh";
  const ownMatch = isMeshNode ? [value] : [];
  return [...ownMatch, ...Object.values(value).flatMap(findMeshNodeSchemas)];
}

/**
 * `meshNodeSchema`'s `.superRefine` (`./scene-node.ts`) enforces "at least
 * one of `geometryRef`/`geometry`, and independently at least one of
 * `materialRef`/`material`, must be present" at runtime - but `z.toJSONSchema`
 * cannot lift an arbitrary `.superRefine` predicate into a structural JSON
 * Schema constraint, so it silently drops it, leaving `geometryRef`/
 * `materialRef`/`geometry`/`material` all plainly optional with no
 * cross-field constraint at all in the generated artifact. Left alone, a
 * document with neither a mesh node's ref nor its inline alternative would
 * validate successfully against `scene.schema.json` even though this
 * package's own `parseScene` rejects it - a real gap for any consumer
 * validating purely against the raw JSON Schema (not through this package's
 * Zod-based `parseScene`). This restores the constraint post-generation, as
 * a structural `allOf`/`anyOf`/`required` combination every JSON Schema
 * validator (this repo's own `ajv`-based tests included; see
 * `json-schema.test.ts`) understands natively.
 */
function injectMeshNodeRefConstraints(root: JsonSchemaNode): void {
  const meshNodeSchemas = findMeshNodeSchemas(root);
  if (meshNodeSchemas.length === 0) {
    throw new Error(
      "generateSceneJsonSchema: no mesh node schema found to inject the geometryRef/materialRef " +
        "'at least one of' constraint onto - did the generated JSON Schema's shape change?",
    );
  }
  for (const meshNodeSchema of meshNodeSchemas) {
    meshNodeSchema.allOf = [
      requireAtLeastOneOf("geometryRef", "geometry"),
      requireAtLeastOneOf("materialRef", "material"),
    ];
  }
}

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
  const jsonSchema = z.toJSONSchema(sceneDocumentSchema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;
  injectMeshNodeRefConstraints(jsonSchema);
  return jsonSchema;
}
