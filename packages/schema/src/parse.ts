import { z } from "zod";

import { CURRENT_SCHEMA_VERSION, type SceneDocument, sceneDocumentSchema } from "./envelope.js";

/**
 * A single, machine-appliable edit to one location in a JSON-like document,
 * addressed by the exact same dotted/bracketed-index path format
 * {@link SceneParseDiagnostic.path} already uses (e.g.
 * `"project.compositions[0].fps"`).
 *
 * - `"replace"`: the value already at `path` is replaced with `value`. Used
 *   when the path is known to already exist (e.g. clamping an out-of-range
 *   number, or trimming whitespace from a string).
 * - `"add"`: `value` is inserted at `path`, either as a new object property
 *   (when the path's final segment names a property) or as a new array
 *   element at that index (shifting any existing element at or after that
 *   index one place later). Used when the path does not yet exist (e.g. a
 *   missing required field).
 * - `"remove"`: whatever is at `path` is deleted outright: an object property
 *   is deleted, an array element is spliced out (shifting later elements one
 *   place earlier). `value` is not used for this op. Used when the safe fix
 *   is simply "this should not be here" (e.g. an unrecognized field name).
 *
 * See `./patch-path.ts` for the utility that actually applies one of these
 * against an arbitrary parsed-JSON value.
 */
export interface SceneDiagnosticPatch {
  /** Which kind of edit this is; see this interface's own doc for the exact semantics of each. */
  op: "replace" | "add" | "remove";
  /** Dotted/bracketed-index path this edit applies at, in the same format as {@link SceneParseDiagnostic.path}. */
  path: string;
  /** The value to write at `path`. Present for `"replace"` and `"add"`; absent (and unused) for `"remove"`. */
  value?: unknown;
}

/**
 * A single actionable problem found while parsing a scene document.
 *
 * `path` names the exact offending field using dotted-property and
 * bracketed-index notation (e.g.
 * `project.compositions[0].tracks[1].clips[0].node.transform.position`), so
 * an agent or a human can jump straight to the offending value without
 * searching. `message` is a human-readable explanation of what was wrong.
 *
 * `code` is a stable, machine-comparable string identifying the *class* of
 * problem (e.g. `"UNKNOWN_NODE_KIND"`, `"VALUE_OUT_OF_RANGE"`), so a caller
 * can branch on it directly instead of pattern-matching `message` (which is
 * prose, and not guaranteed to stay byte-for-byte stable). See
 * `docs/diagnostic-codes.md` for the full, documented list of every value
 * this package emits.
 *
 * `expected` and `suggestedFix` are both best-effort enrichments, populated
 * whenever the underlying Zod issue carries enough structure to derive them
 * (see `enrichIssue` below): a short description of what was actually
 * expected at `path`, and a short, human/agent-readable actionable
 * suggestion for how to fix it. Both are plain descriptive strings, not a
 * machine-appliable patch.
 *
 * `received` is the actual offending value found at `path` (from the
 * underlying Zod issue's own `input`, where the issue carries one), kept
 * JSON-serializable: a value that is not already JSON-serializable (e.g.
 * `undefined`, a `bigint`, a `symbol`) is omitted rather than included as
 * something a caller could not `JSON.stringify` and send back over MCP.
 *
 * `suggestedPatch`, when present, is a single {@link SceneDiagnosticPatch}
 * that, if applied at `path`, is expected to resolve this specific
 * diagnostic (though not necessarily every other diagnostic the same
 * document may also have). It is populated only for error classes with a
 * genuinely safe, unambiguous automatic fix (see `deriveSuggestedPatch`
 * below for exactly which ones, and why); every other diagnostic leaves this
 * `undefined` rather than fabricate a guess that might not be what the
 * document's author intended. `repair_scene` (in `@cadra/mcp-server`) is the
 * tool that actually applies these on request.
 */
export interface SceneParseDiagnostic {
  /** Path to the offending field, e.g. `project.compositions[0].tracks[1]`. */
  path: string;
  /** Human-readable explanation of what was wrong at `path`. */
  message: string;
  /**
   * Stable string identifying the class of error this diagnostic represents,
   * e.g. `"UNKNOWN_NODE_KIND"` or `"VALUE_OUT_OF_RANGE"`. See
   * `docs/diagnostic-codes.md` for the exhaustive, documented list.
   */
  code: string;
  /**
   * Short description of what was actually expected at `path`, e.g.
   * `"number"` or `"one of: group, mesh, camera, light, text, image, compositionRef"`.
   * Omitted when the underlying issue (typically a `custom` issue raised by
   * one of this package's own `.superRefine` checks) carries no structured
   * expectation to describe beyond its `message`.
   */
  expected?: string;
  /**
   * The actual offending value found at `path`, kept JSON-serializable.
   * Omitted when the underlying issue carries no `input` value (e.g. a
   * `custom` issue about a cross-field rule with no single offending value),
   * or when that value is not itself JSON-serializable.
   */
  received?: unknown;
  /**
   * A short, actionable, human/agent-readable suggestion for how to fix the
   * problem at `path`, e.g. `"Provide a number for fps."` or `"Use one of
   * the supported kinds: group, mesh, camera, light, text, image, compositionRef."`.
   * Omitted under the same conditions as `expected`.
   */
  suggestedFix?: string;
  /**
   * A single machine-appliable patch that resolves this diagnostic, present
   * only when this error class has a safe, unambiguous automatic fix. See
   * this interface's own doc, and `deriveSuggestedPatch`, for exactly which
   * error classes qualify.
   */
  suggestedPatch?: SceneDiagnosticPatch;
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
 * Returns `value` unchanged if it is JSON-serializable as-is (a plain
 * object, array, string, number, boolean, or `null`), or `undefined` if it
 * is not (e.g. `undefined` itself, a `bigint`, a `symbol`, a function): the
 * `received` field on a diagnostic must survive a round trip through
 * `JSON.stringify`/`JSON.parse` (an MCP tool result is always JSON), so a
 * value that cannot is omitted rather than included as something unusable to
 * every caller across that boundary.
 *
 * This is deliberately shallow, not a recursive sanitizer: every `input` a
 * Zod issue in this package's own schemas ever carries is either a scalar
 * (the common case: a bad `fps`, a bad `kind`) or, for a whole-object issue
 * like `unrecognized_keys`, an already-JSON-shaped record straight out of
 * `JSON.parse`'d input. A value nested arbitrarily deep inside a non-JSON
 * wrapper is not a shape this package's own parsing ever produces.
 */
function toJsonSerializable(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  const valueType = typeof value;
  if (valueType === "bigint" || valueType === "symbol" || valueType === "function") {
    return undefined;
  }
  return value;
}

/**
 * A stable marker this package's own `.superRefine` checks (and the
 * cross-cutting checks in `parseScene` itself, see `checkAssetRefs` below)
 * stash on a Zod `custom` issue's `params` bag, so `enrichIssue` can
 * recognize deterministically *which* hand-written check raised a given
 * `custom` issue, rather than pattern-matching its prose `message`.
 *
 * Not every `custom` issue in this package sets this: the pre-existing
 * cross-field checks in `./timeline.ts` and `./keyframes.ts` (transition/
 * direction pairing, keyframe frame ordering, audio fade duration) predate
 * this phase and are deliberately left as plain `custom` issues with no
 * stable code of their own; see `enrichIssue`'s `default` branch for how
 * those still get a reasonable fallback `code`.
 */
const CADRA_DIAGNOSTIC_CODE_PARAM = "cadraDiagnosticCode";

/** Reads the {@link CADRA_DIAGNOSTIC_CODE_PARAM} marker off a `custom` issue's `params`, if present. */
function customIssueCode(issue: z.core.$ZodIssueCustom): string | undefined {
  const marker = issue.params?.[CADRA_DIAGNOSTIC_CODE_PARAM];
  return typeof marker === "string" ? marker : undefined;
}

/**
 * Every diagnostic `code` this package can emit. Kept as a single `const`
 * object (rather than scattering the literal strings across `enrichIssue`)
 * so `docs/diagnostic-codes.md` and this package's tests both have one
 * unambiguous source to check against for "did I cover every code".
 *
 * See `docs/diagnostic-codes.md` for what each of these means, and whether
 * it typically carries a `suggestedPatch`.
 */
export const DIAGNOSTIC_CODES = {
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  WRONG_TYPE: "WRONG_TYPE",
  UNKNOWN_NODE_KIND: "UNKNOWN_NODE_KIND",
  INVALID_DISCRIMINATED_UNION: "INVALID_DISCRIMINATED_UNION",
  INVALID_ENUM_VALUE: "INVALID_ENUM_VALUE",
  VALUE_OUT_OF_RANGE: "VALUE_OUT_OF_RANGE",
  UNRECOGNIZED_FIELD: "UNRECOGNIZED_FIELD",
  UNSUPPORTED_SCHEMA_VERSION: "UNSUPPORTED_SCHEMA_VERSION",
  INVALID_ASSET_REF: "INVALID_ASSET_REF",
  INVALID_CROSS_FIELD_RULE: "INVALID_CROSS_FIELD_RULE",
} as const;

/** One of the fixed set of stable diagnostic codes this package emits; see {@link DIAGNOSTIC_CODES}. */
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[keyof typeof DIAGNOSTIC_CODES];

/**
 * Derives the stable `code` for one Zod issue. Every structurally-recognized
 * issue type below gets its own specific code; a `custom` issue either
 * carries its own explicit marker (see `customIssueCode`, set by
 * `checkAssetRefs` below) or, lacking one (every pre-existing hand-written
 * cross-field `.superRefine` in `./timeline.ts`/`./keyframes.ts`), falls back
 * to the general `INVALID_CROSS_FIELD_RULE`.
 */
function deriveCode(issue: z.core.$ZodIssue): DiagnosticCode {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined
        ? DIAGNOSTIC_CODES.MISSING_REQUIRED_FIELD
        : DIAGNOSTIC_CODES.WRONG_TYPE;

    case "invalid_union":
      return "discriminator" in issue && issue.discriminator === "kind"
        ? DIAGNOSTIC_CODES.UNKNOWN_NODE_KIND
        : DIAGNOSTIC_CODES.INVALID_DISCRIMINATED_UNION;

    case "invalid_value":
      return DIAGNOSTIC_CODES.INVALID_ENUM_VALUE;

    case "too_big":
    case "too_small":
      return DIAGNOSTIC_CODES.VALUE_OUT_OF_RANGE;

    case "unrecognized_keys":
      return DIAGNOSTIC_CODES.UNRECOGNIZED_FIELD;

    case "custom":
      return (customIssueCode(issue) as DiagnosticCode | undefined) ?? DIAGNOSTIC_CODES.INVALID_CROSS_FIELD_RULE;

    default:
      return DIAGNOSTIC_CODES.INVALID_CROSS_FIELD_RULE;
  }
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
      const bound =
        issue.inclusive === false ? `less than ${issue.maximum}` : `at most ${issue.maximum}`;
      return {
        expected: `a value ${bound}`,
        suggestedFix: `Lower the value at ${where} to ${bound}.`,
      };
    }

    case "too_small": {
      const bound =
        issue.inclusive === false ? `greater than ${issue.minimum}` : `at least ${issue.minimum}`;
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

/**
 * A conservative, per-field-name default value used only to derive a
 * `suggestedPatch` for a *missing* required numeric field
 * (`MISSING_REQUIRED_FIELD` where the expected type is a number). Not every
 * missing field is safe to default: a missing `id` has no sensible default
 * (a fabricated id could collide with another node), a missing `kind` is the
 * `UNKNOWN_NODE_KIND` case handled separately (and deliberately left
 * unpatched). This table only covers the numeric fields common enough, and
 * unambiguous enough in their "obviously safe" default, to be worth
 * auto-fixing: a frame-rate-like or duration-like field defaults to a small
 * positive value, a coordinate-like field defaults to zero.
 *
 * Deliberately a plain field-name lookup, not a schema-aware default
 * resolver: this keeps `deriveSuggestedPatch` simple and auditable (every
 * default is right here, in one table, each with a stated reason) rather
 * than trying to teach it to infer "is this numeric field more like a count
 * or more like a coordinate" from the schema shape alone.
 */
const SAFE_NUMERIC_FIELD_DEFAULTS: ReadonlyMap<string, number> = new Map([
  ["fps", 30],
  ["durationInFrames", 1],
  ["startFrame", 0],
  ["width", 1],
  ["height", 1],
  ["intensity", 1],
  ["fontSize", 16],
  ["gain", 1],
]);

/**
 * Given the final property-name segment of a missing field's path, returns
 * the safe default value to fill it with, or `undefined` if this field name
 * is not in {@link SAFE_NUMERIC_FIELD_DEFAULTS} (in which case no
 * `suggestedPatch` is generated for that `MISSING_REQUIRED_FIELD`
 * diagnostic; see this module's doc for why "no safe default known" must
 * mean "no patch" rather than a guess).
 */
function safeDefaultForFieldName(path: ReadonlyArray<PropertyKey>): number | undefined {
  const lastSegment = path[path.length - 1];
  if (typeof lastSegment !== "string") {
    return undefined;
  }
  return SAFE_NUMERIC_FIELD_DEFAULTS.get(lastSegment);
}

/**
 * Derives a {@link SceneDiagnosticPatch} for one Zod issue, or `undefined` if
 * this issue's error class has no safe, unambiguous automatic fix.
 *
 * Exactly four issue shapes get a patch, matching the four headline error
 * classes this phase targets:
 *
 * - `MISSING_REQUIRED_FIELD` (a `invalid_type` issue with `input ===
 *   undefined`) for a field whose expected type is `"number"` *and* whose
 *   final path segment is a recognized, obviously-safe-to-default field name
 *   (see {@link SAFE_NUMERIC_FIELD_DEFAULTS}): an `"add"` patch supplying
 *   that default. A missing field of any other type (string, boolean,
 *   object, array), or a numeric field not in that table, has no
 *   sufficiently unambiguous default (what string? what should an
 *   arbitrary flag default to?) and is left unpatched.
 * - `VALUE_OUT_OF_RANGE` (`too_big` / `too_small`) for a numeric bound: a
 *   `"replace"` patch clamping the value to the nearest allowed bound
 *   (respecting `inclusive`/`exact`, nudging one unit further for a
 *   strictly-exclusive or `.int()` bound so the clamped value itself still
 *   passes). Always safe: a clamp by definition lands inside the allowed
 *   range, and "closest allowed value" is the least surprising unambiguous
 *   interpretation of "this number is out of range".
 * - `UNRECOGNIZED_FIELD` (`unrecognized_keys`) for a `z.strictObject` that
 *   saw a field name it does not recognize: a `"remove"` patch deleting each
 *   offending key. Always safe: the field is, by definition, not part of
 *   this shape at all, so removing it cannot destroy anything the schema
 *   considers meaningful (if the author meant a *different*, correctly-
 *   spelled field, that is still a `suggestedFix`-only prose hint, not
 *   something this function can safely guess at).
 * - `INVALID_ASSET_REF` (a `custom` issue this package's own `checkAssetRefs`
 *   raises, see below) *only* when the offending ref is blank solely because
 *   of leading/trailing whitespace around otherwise-non-empty content: a
 *   `"replace"` patch with the trimmed string. A ref that is empty, or
 *   entirely whitespace, has no real content to recover a fix from (which
 *   asset was meant?) and is deliberately left unpatched.
 *
 * `UNKNOWN_NODE_KIND` (`invalid_union` on the `kind` discriminator) is
 * deliberately never patched here: see this function's own module doc and
 * `docs/diagnostic-codes.md` for why guessing a replacement `kind` is not a
 * safe automatic fix.
 */
function deriveSuggestedPatch(issue: z.core.$ZodIssue): SceneDiagnosticPatch | undefined {
  const path = formatIssuePath(issue.path);

  switch (issue.code) {
    case "invalid_type": {
      if (issue.input !== undefined || issue.expected !== "number") {
        return undefined;
      }
      const defaultValue = safeDefaultForFieldName(issue.path);
      if (defaultValue === undefined) {
        return undefined;
      }
      return { op: "add", path, value: defaultValue };
    }

    case "too_big": {
      if (typeof issue.maximum !== "number") {
        return undefined;
      }
      const clamped = issue.inclusive === false ? issue.maximum - 1 : issue.maximum;
      return { op: "replace", path, value: clamped };
    }

    case "too_small": {
      if (typeof issue.minimum !== "number") {
        return undefined;
      }
      const clamped = issue.inclusive === false ? issue.minimum + 1 : issue.minimum;
      return { op: "replace", path, value: clamped };
    }

    case "unrecognized_keys": {
      // One diagnostic covers every unrecognized key on this object at once
      // (see `toDiagnostics`'s per-key expansion below, which turns this one
      // Zod issue into one diagnostic per offending key so each gets its own
      // independently-appliable patch), so this branch is only ever reached
      // once per key, with `issue` already narrowed to that single key by
      // the caller.
      return { op: "remove", path };
    }

    case "custom": {
      if (customIssueCode(issue) !== DIAGNOSTIC_CODES.INVALID_ASSET_REF) {
        return undefined;
      }
      const trimmed = typeof issue.input === "string" ? issue.input.trim() : "";
      if (trimmed.length === 0) {
        // Blank (or whitespace-only) with nothing recoverable to trim to:
        // no safe default exists for "which asset did you mean".
        return undefined;
      }
      return { op: "replace", path, value: trimmed };
    }

    default:
      return undefined;
  }
}

/**
 * Expands one Zod `unrecognized_keys` issue (which names every offending key
 * on one object in a single issue) into one {@link SceneParseDiagnostic} per
 * key, each with its own `path` (the object's path plus the key name) and
 * its own independently-appliable `"remove"` `suggestedPatch`. Splitting
 * these out means `repair_scene` can drop exactly the offending keys without
 * needing to parse a comma-joined key list back out of a single diagnostic's
 * `path`.
 */
function unrecognizedKeysToDiagnostics(issue: z.core.$ZodIssueUnrecognizedKeys): SceneParseDiagnostic[] {
  const objectPath = formatIssuePath(issue.path);
  const { suggestedFix } = enrichIssue(issue);

  return issue.keys.map((key) => {
    const keyPath = objectPath === "<root>" ? key : `${objectPath}.${key}`;
    return {
      path: keyPath,
      message: `Unrecognized field '${key}' at ${objectPath === "<root>" ? "the document root" : objectPath}. ${issue.message}`,
      code: DIAGNOSTIC_CODES.UNRECOGNIZED_FIELD,
      expected: "no additional properties",
      suggestedFix,
      suggestedPatch: { op: "remove", path: keyPath },
    };
  });
}

/** Maps one Zod issue to one (or, for `unrecognized_keys`, more than one) {@link SceneParseDiagnostic}. */
function issueToDiagnostics(issue: z.core.$ZodIssue): SceneParseDiagnostic[] {
  if (issue.code === "unrecognized_keys") {
    return unrecognizedKeysToDiagnostics(issue);
  }

  return [
    {
      path: formatIssuePath(issue.path),
      message: issue.message,
      code: deriveCode(issue),
      received: toJsonSerializable(issue.input),
      ...enrichIssue(issue),
      suggestedPatch: deriveSuggestedPatch(issue),
    },
  ];
}

/** Maps a Zod `ZodError`'s issue list directly to `SceneParseDiagnostic[]`. */
function toDiagnostics(error: z.ZodError): SceneParseDiagnostic[] {
  return error.issues.flatMap((issue) => issueToDiagnostics(issue));
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
 * Field names, on any scene-node-like object, that hold an id resolved
 * against an external asset/geometry/material/font registry. Checked by
 * {@link checkAssetRefs} against the already-schema-valid parsed document (so
 * this runs only once the document is known to at least be shaped
 * correctly): a blank (empty or whitespace-only) ref string cannot possibly
 * resolve to anything, so it is flagged as `INVALID_ASSET_REF` even though
 * a bare `z.string()` field accepts it.
 *
 * Kept as a fixed field-name allow-list, not a schema-driven walk: the
 * schema itself has no marker distinguishing "this string field is a
 * resolved-elsewhere ref" from "this string field is free-form text" (e.g.
 * `TextNode.content`), so the allow-list is the simplest correct source of
 * truth, matching exactly the fields `docs/agent-authoring-guide.md`
 * documents as ref fields (`geometryRef`, `materialRef`, `assetRef`,
 * `fontRef`).
 */
const ASSET_REF_FIELD_NAMES = new Set(["assetRef", "geometryRef", "materialRef", "fontRef"]);

/**
 * Walks `value` (the already schema-valid, parsed document) looking for any
 * of {@link ASSET_REF_FIELD_NAMES} holding a string that is not a plausible
 * ref: either blank (empty or whitespace-only), or merely padded with
 * leading/trailing whitespace around otherwise-real content (e.g.
 * `" geo-1 "`, almost certainly a copy/paste artifact rather than an
 * intentional part of the id). Returns one `custom`-shaped issue per
 * offending field, each tagged with the {@link CADRA_DIAGNOSTIC_CODE_PARAM}
 * marker for `INVALID_ASSET_REF` so `deriveCode`/`deriveSuggestedPatch`
 * recognize it.
 *
 * `fontRef` is optional on `TextNode`; an *absent* `fontRef` is not an error
 * (the field's own doc says omission means "the renderer's default"), so
 * this only flags a ref field that is *present* and blank/padded, never a
 * merely missing optional one.
 *
 * This is a plain recursive walk over parsed JSON, not a Zod schema check,
 * for the same reason `readSchemaVersion` above is a plain shape check
 * rather than a schema: it is a narrow, cross-cutting rule (any field named
 * like a ref, anywhere in the document) that does not belong to any single
 * node kind's own shape, so bolting it onto every one of `scene-node.ts`'s
 * seven `strictObject`s (and `timeline.ts`'s `audioClipSchema`) individually
 * would scatter one rule across eight places for no benefit.
 */
function checkAssetRefs(value: unknown, path: PropertyKey[] = []): z.core.$ZodIssueCustom[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => checkAssetRefs(item, [...path, index]));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const issues: z.core.$ZodIssueCustom[] = [];
  for (const [key, fieldValue] of Object.entries(value)) {
    const fieldPath = [...path, key];
    const isBlankOrPadded =
      typeof fieldValue === "string" && (fieldValue.trim().length === 0 || fieldValue !== fieldValue.trim());
    if (ASSET_REF_FIELD_NAMES.has(key) && isBlankOrPadded) {
      // Covers both a fully blank/whitespace-only ref (trims to "", whether
      // or not there was anything to trim in the first place) and a
      // padded-but-real one (trims to something shorter than the original);
      // `deriveSuggestedPatch` tells these two apart by checking whether the
      // trimmed result is still empty.
      issues.push({
        code: "custom",
        message:
          fieldValue.trim().length === 0
            ? `'${key}' must not be blank; it identifies an asset resolved against a registry.`
            : `'${key}' has leading/trailing whitespace ("${fieldValue}"); an asset ref must not be padded with whitespace.`,
        path: fieldPath,
        input: fieldValue,
        params: { [CADRA_DIAGNOSTIC_CODE_PARAM]: DIAGNOSTIC_CODES.INVALID_ASSET_REF },
      });
    }
    issues.push(...checkAssetRefs(fieldValue, fieldPath));
  }
  return issues;
}

/**
 * Parses `input` as a Cadra scene document: a `{ schemaVersion, project }`
 * envelope whose `project` matches the exact `Project` shape from
 * `@cadra/core`.
 *
 * On success, `result.document` is the fully-typed, validated document. On
 * failure, `result.diagnostics` lists every problem found, each naming the
 * exact offending field path and a human-readable message, a stable `code`
 * identifying the error class, and (where derivable) the actual offending
 * `received` value, an `expected`/`suggestedFix` prose enrichment, and a
 * machine-appliable `suggestedPatch`, sourced from Zod's own `safeParse`
 * issue list plus this package's own cross-cutting `checkAssetRefs` pass.
 *
 * An unrecognized or missing `schemaVersion` is rejected with a single clear
 * diagnostic naming the unsupported version, rather than silently accepted
 * or reported as a confusing generic type mismatch. This diagnostic
 * deliberately never carries a `suggestedPatch`: correcting `schemaVersion`
 * alone, without also migrating `project`'s shape to match (see
 * `migrateSceneDocument`), would silently produce a document that *parses*
 * successfully but no longer means what its author intended, which is a
 * strictly worse outcome than leaving it as a clear, unpatched failure.
 *
 * The asset-ref check only runs once the document is otherwise schema-valid:
 * a document with a structural problem elsewhere gets exactly the Zod
 * diagnostics for that problem, not a secondary flood of ref-blankness
 * issues layered on top of an already-broken shape.
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
          code: DIAGNOSTIC_CODES.UNSUPPORTED_SCHEMA_VERSION,
          received: schemaVersion,
          expected: `the literal number ${CURRENT_SCHEMA_VERSION}`,
          suggestedFix:
            `Set schemaVersion to ${CURRENT_SCHEMA_VERSION}, migrating the document's shape to ` +
            "match if it was authored against an older version (see migrateSceneDocument).",
        },
      ],
    };
  }

  // `reportInput: true` makes Zod populate each issue's own `input` with the
  // exact offending value at that issue's `path` (rather than leaving it
  // unset, Zod's default): this is what lets `deriveCode` tell a genuinely
  // *missing* field (`input` stays `undefined`, since there is nothing at
  // that path to report) apart from a *present-but-wrong-type* one (`input`
  // is the actual wrong value), and lets `received` below report that actual
  // value.
  const result = sceneDocumentSchema.safeParse(input, { reportInput: true });

  if (!result.success) {
    return { success: false, diagnostics: toDiagnostics(result.error) };
  }

  const assetRefIssues = checkAssetRefs(result.data);
  if (assetRefIssues.length > 0) {
    return { success: false, diagnostics: assetRefIssues.flatMap((issue) => issueToDiagnostics(issue)) };
  }

  return { success: true, document: result.data };
}
