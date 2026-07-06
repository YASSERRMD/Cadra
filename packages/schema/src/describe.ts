import { type CapabilityManifest, generateCapabilityManifest } from "./capabilities.js";
import { CURRENT_SCHEMA_VERSION } from "./envelope.js";
import { EXAMPLE_SCENE_DOCUMENTS, type NamedSceneDocumentExample } from "./examples.js";
import { generateSceneJsonSchema } from "./json-schema.js";

/**
 * The full, versioned Cadra scene contract, composed from every Phase 27
 * export: the JSON Schema (shape), the capability manifest (vocabulary:
 * primitives, properties, easings, and the optional `codecs` extension
 * point), and the curated example set (real, valid documents to read
 * alongside the machine-readable pieces).
 *
 * This is the single function an agent needs to call at runtime to learn
 * the entire Cadra scene format with no other lookup: `describeCadraContract()`
 * returns everything `parseScene` validates against, everything the
 * capability manifest documents, and real examples, all tagged with the
 * same `schemaVersion` so a consumer can tell exactly which contract
 * version it received (and detect a mismatch if it cached a contract from
 * an older build).
 */
export interface CadraContract {
  /** The schema contract version every field below was generated against. */
  schemaVersion: number;
  /** The JSON Schema for the full `{ schemaVersion, project }` scene envelope (see `generateSceneJsonSchema`). */
  jsonSchema: Record<string, unknown>;
  /** The capability manifest: primitives, properties, easings, and an optional codecs extension point. */
  capabilities: CapabilityManifest;
  /** The curated example set: a handful of valid, realistic `SceneDocument`s. */
  examples: readonly NamedSceneDocumentExample[];
}

/**
 * Returns the full Cadra scene contract for an agent (or a human, or a
 * doc/tooling generator) to read at runtime: `{ schemaVersion, jsonSchema,
 * capabilities, examples }`.
 *
 * Every piece is generated fresh from this package's own schemas each call
 * (nothing here is cached module state), so the result can never drift from
 * what `parseScene` actually accepts, matching the same freshness guarantee
 * `generateSceneJsonSchema` and `generateCapabilityManifest` each already
 * provide individually.
 */
export function describeCadraContract(): CadraContract {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    jsonSchema: generateSceneJsonSchema(),
    capabilities: generateCapabilityManifest(),
    examples: EXAMPLE_SCENE_DOCUMENTS,
  };
}
