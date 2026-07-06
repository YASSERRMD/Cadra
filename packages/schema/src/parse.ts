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
 *
 * `expected` and `suggestedFix` are both best-effort enrichments, populated
 * whenever the underlying Zod issue carries enough structure to derive them
 * (see `enrichIssue` below): a short description of what was actually
 * expected at `path`, and a short, human/agent-readable actionable
 * suggestion for how to fix it. Both are plain descriptive strings, not a
 * machine-appliable patch: turning a diagnostic into an automatically-applied
 * fix (a structured `suggestedPatch` object, a `repair_scene` tool) is
 * explicitly out of scope for this phase and left to a later one.
 */
export interface SceneParseDiagnostic {
  /** Path to the offending field, e.g. `project.compositions[0].tracks[1]`. */
  path: string;
  /** Human-readable explanation of what was wrong at `path`. */
  message: string;
  /**
   * Short description of what was actually expected at `path`, e.g.
   * `"number"` or `"one of: group, mesh, camera, light, text, image, compositionRef"`.
   * Omitted when the underlying issue (typically a `custom` issue raised by
   * one of this package's own `.superRefine` checks) carries no structured
   * expectation to describe beyond its `message`.
   */
  expected?: string;
  /**
   * A short, actionable, human/agent-readable suggestion for how to fix the
   * problem at `path`, e.g. `"Provide a number for fps."` or `"Use one of
   * the supported kinds: group, mesh, camera, light, text, image, compositionRef."`.
   * Omitted under the same conditions as `expected`.
   */
  suggestedFix?: string;
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

/**
 * Renders a Zod issue's `path` as a short "at <path>" (or "at the document
 * root" for an empty path) clause, for splicing into a `suggestedFix`
 * sentence. Kept separate from `formatIssuePath` (which always returns
 * `"<root>"` for the diagnostic's own `path` field) since a `suggestedFix`
 * reads better as prose than as the bracketed placeholder.
 */
function describePathForFix(path: ReadonlyArray<PropertyKey>): string {
  const formatted = formatIssuePath(path);
  return formatted === "<root>" ? "the document root" : formatted;
}

/**
 * Formats a fixed list of allowed values as a comma-separated string for use
 * in both `expected` and `suggestedFix`, e.g. `["group", "mesh"]` becomes
 * `"group, mesh"`.
 */
function formatAllowedValues(values: ReadonlyArray<unknown>): string {
  return values.map((value) => String(value)).join(", ");
}

/**
 * Derives a short `expected` description and an actionable `suggestedFix`
 * for one Zod issue, covering the common, structurally-recognizable error
 * classes this package's own schemas raise:
 *
 * - `invalid_type`: a field is missing entirely (the input was `undefined`)
 *   or holds a value of the wrong type.
 * - `invalid_union` with a `discriminator`: an unrecognized discriminant
 *   value, the shape `sceneNodeSchema`'s `kind` mismatch takes (an unknown
 *   node `kind` is the headline case this covers, but the same derivation
 *   applies to any future discriminated union in this package).
 * - `invalid_value`: a bare enum/literal mismatch (e.g. an unknown
 *   `lightType`), Zod's shape for a value outside a fixed allowed set.
 * - `too_big` / `too_small`: a numeric (or other orderable) value outside
 *   its allowed range.
 * - `unrecognized_keys`: an object carries a field name this package's
 *   `z.strictObject` schemas do not recognize, commonly a typo or a
 *   misremembered field name.
 *
 * Every other issue code (chiefly `custom`, the code every `.superRefine` in
 * `./timeline.ts` and `./keyframes.ts` raises for cross-field rules like
 * transition/direction pairing or strictly-increasing keyframe frames)
 * already carries a full, specific, hand-written `message` with nothing
 * further to mechanically derive, so both fields are left `undefined` and
 * the diagnostic's `message` remains the only, sufficient explanation.
 */
function enrichIssue(issue: z.core.$ZodIssue): {
  expected?: string;
  suggestedFix?: string;
} {
  const where = describePathForFix(issue.path);

  switch (issue.code) {
    case "invalid_type": {
      const isMissing = issue.input === undefined;
      return {
        expected: issue.expected,
        suggestedFix: isMissing
          ? `Add a value for ${where}; expected ${issue.expected}.`
          : `Change the value at ${where} to ${issue.expected}.`,
      };
    }

    case "invalid_union": {
      if ("options" in issue && issue.discriminator !== undefined && issue.options !== undefined) {
        const allowed = formatAllowedValues(issue.options);
        return {
          expected: `one of: ${allowed}`,
          suggestedFix: `Set ${where} to one of the supported values for '${issue.discriminator}': ${allowed}.`,
        };
      }
      return {};
    }

    case "invalid_value": {
      const allowed = formatAllowedValues(issue.values);
      return {
        expected: `one of: ${allowed}`,
        suggestedFix: `Set ${where} to one of: ${allowed}.`,
      };
    }

    case "too_big": {
      const bound = issue.inclusive === false ? `less than ${issue.maximum}` : `at most ${issue.maximum}`;
      return {
        expected: `a value ${bound}`,
        suggestedFix: `Lower the value at ${where} to ${bound}.`,
      };
    }

    case "too_small": {
      const bound = issue.inclusive === false ? `greater than ${issue.minimum}` : `at least ${issue.minimum}`;
      return {
        expected: `a value ${bound}`,
        suggestedFix: `Raise the value at ${where} to ${bound}.`,
      };
    }

    case "unrecognized_keys": {
      const keys = issue.keys.join(", ");
      return {
        expected: "no additional properties",
        suggestedFix: `Remove the unrecognized field(s) (${keys}) at ${where}, or check for a typo against the documented field names.`,
      };
    }

    default:
      return {};
  }
}

/** Maps a Zod `ZodError`'s issue list directly to `SceneParseDiagnostic[]`. */
function toDiagnostics(error: z.ZodError): SceneParseDiagnostic[] {
  return error.issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    message: issue.message,
    ...enrichIssue(issue),
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
 * from Zod's own `safeParse` issue list, and enriched (where derivable) with
 * `expected` and `suggestedFix` so an agent can self-correct without
 * inspecting the JSON Schema or capability manifest first.
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
          expected: `the literal number ${CURRENT_SCHEMA_VERSION}`,
          suggestedFix:
            `Set schemaVersion to ${CURRENT_SCHEMA_VERSION}, migrating the document's shape to ` +
            "match if it was authored against an older version (see migrateSceneDocument).",
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
