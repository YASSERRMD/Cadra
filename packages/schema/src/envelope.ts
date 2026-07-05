import { z } from "zod";

import { projectSchema } from "./timeline.js";

/**
 * The top-level envelope every persisted or agent-emitted scene document is
 * wrapped in.
 *
 * `schemaVersion` deliberately lives alongside `project`, not inside it: the
 * envelope is versioning metadata about the *document*, while `project` is
 * exactly the Phase 2 `Project` shape (see the drift check on
 * `projectSchema` in `./timeline.ts`), with nothing extra spliced in. Keeping
 * them as siblings means the migration hook in `./migrate.ts` can rewrite
 * `project` for a version bump without `Project`'s own shape ever needing a
 * version-tagging field of its own.
 */

/**
 * The current schema version this package's schemas and parser implement.
 * Bump this (and register a migration in `./migrate.ts`) whenever the
 * envelope or `Project` shape changes in a way that is not backward
 * compatible.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/** The literal schema version this build of the package understands. */
export const schemaVersionSchema = z
  .literal(CURRENT_SCHEMA_VERSION)
  .describe("The scene document schema version this document was authored against.");

/**
 * The full envelope: a `schemaVersion` tag plus the `Project` it describes.
 * This is the type `parseScene` accepts as its logical input shape (after
 * validating `schemaVersion` is a supported value; see `./parse.ts`).
 */
export const sceneDocumentSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  project: projectSchema.describe("The full project this document describes."),
});

/** The fully-typed shape of a parsed, current-version scene document. */
export type SceneDocument = z.infer<typeof sceneDocumentSchema>;
