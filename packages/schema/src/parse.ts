import { z } from "zod";

import { CURRENT_SCHEMA_VERSION, type SceneDocument, sceneDocumentSchema } from "./envelope.js";

/**
 * A single actionable problem found while parsing a scene document.
 *
 * `path` names the exact offending field using dotted-property and
 * bracketed-index notation (e.g.
 * `project.compositions[0].tracks[1].clips[0].node.transform.position`), so
 * an agent or a human can jump straight to the offending value without
 * searching. `message` is a human-readable explanation of what was wrong.
 */
export interface SceneParseDiagnostic {
  /** Path to the offending field, e.g. `project.compositions[0].tracks[1]`. */
  path: string;
  /** Human-readable explanation of what was wrong at `path`. */
  message: string;
}

/** A scene document that parsed successfully. */
export interface SceneParseSuccess {
  success: true;
  document: SceneDocument;
}

/** A scene document that failed to parse, with actionable diagnostics. */
export interface SceneParseFailure {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

/**
 * The result of `parseScene`: a discriminated union on `success`, so callers
 * narrow to either the fully-typed parsed document or the list of
 * diagnostics with a single `if (result.success)` check.
 */
export type SceneParseResult = SceneParseSuccess | SceneParseFailure;

/**
 * Formats a Zod issue `path` (an array of string property names and numeric
 * array indices) as a single dotted/bracketed path string, e.g.
 * `["project", "compositions", 0, "tracks", 1]` becomes
 * `"project.compositions[0].tracks[1]"`.
 *
 * An empty path (an issue about the document root itself, such as an
 * envelope-level union mismatch) formats as `"<root>"` rather than an empty
 * string, so every diagnostic always names a non-empty location.
 */
function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return "<root>";
  }

  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else {
      formatted += formatted.length === 0 ? String(segment) : `.${String(segment)}`;
    }
  }
  return formatted;
}

/** Maps a Zod `ZodError`'s issue list directly to `SceneParseDiagnostic[]`. */
function toDiagnostics(error: z.ZodError): SceneParseDiagnostic[] {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
  }));
}

/**
 * A minimal shape check used only to read `schemaVersion` off of otherwise
 * unvalidated input, so an unsupported version can be reported as one clear
 * diagnostic instead of whatever generic issue the full envelope schema
 * would otherwise raise for a `schemaVersion` value it does not recognize.
 */
function readSchemaVersion(input: unknown): number | undefined {
  if (typeof input !== "object" || input === null || !("schemaVersion" in input)) {
    return undefined;
  }
  const value = (input as { schemaVersion: unknown }).schemaVersion;
  return typeof value === "number" ? value : undefined;
}

/**
 * Parses `input` as a Cadra scene document: a `{ schemaVersion, project }`
 * envelope whose `project` matches the exact `Project` shape from
 * `@cadra/core`.
 *
 * On success, `result.document` is the fully-typed, validated document. On
 * failure, `result.diagnostics` lists every problem found, each naming the
 * exact offending field path and a human-readable message, sourced directly
 * from Zod's own `safeParse` issue list.
 *
 * An unrecognized or missing `schemaVersion` is rejected with a single clear
 * diagnostic naming the unsupported version, rather than silently accepted
 * or reported as a confusing generic type mismatch.
 */
export function parseScene(input: unknown): SceneParseResult {
  const schemaVersion = readSchemaVersion(input);

  if (schemaVersion !== undefined && schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return {
      success: false,
      diagnostics: [
        {
          path: "schemaVersion",
          message:
            `Unsupported schema version ${schemaVersion}. This build of @cadra/schema only ` +
            `understands schema version ${CURRENT_SCHEMA_VERSION}.`,
        },
      ],
    };
  }

  const result = sceneDocumentSchema.safeParse(input);

  if (!result.success) {
    return { success: false, diagnostics: toDiagnostics(result.error) };
  }

  return { success: true, document: result.data };
}
