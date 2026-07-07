# Diagnostic codes

`parseScene` (in `@cadra/schema`) returns a `SceneParseDiagnostic[]` on
failure. Each diagnostic carries a `path` (the exact offending field, in
`project.compositions[0].tracks[1]`-style dotted/bracketed notation), a
human-readable `message`, and a stable `code` identifying the *class* of
problem, so an agent can branch on `code` directly instead of pattern-matching
prose. Where the underlying issue is structured enough, a diagnostic also
carries `expected` (what was actually expected at `path`), `received` (the
actual offending value, when it is JSON-serializable), `suggestedFix` (a
short, human/agent-readable prose suggestion), and `suggestedPatch` (a single
machine-appliable `{ op, path, value? }` edit that, applied at `path`, resolves
that specific diagnostic).

`repair_scene` (in `@cadra/mcp-server`) automatically applies every
`suggestedPatch` a persisted scene's diagnostics carry, then re-validates.
Only codes marked **auto-patched below** ever carry a `suggestedPatch`; every
other code is left for a human or agent to fix manually (typically via
`update_scene`), because guessing a fix for it could silently produce a
document that parses but no longer means what its author intended.

## The codes

### `MISSING_REQUIRED_FIELD`

A required field is absent entirely (its value is `undefined`, not merely
`null` or an empty string).

**Auto-patched**: only when the missing field's expected type is `number` and
its name is one of a small, conservative allow-list of fields with an
obviously-safe default (`fps`, `durationInFrames`, `startFrame`, `width`,
`height`, `intensity`, `fontSize`, `gain`). A missing field of any other type,
or a numeric field not on that list, has no sufficiently unambiguous default
and is left unpatched.

### `WRONG_TYPE`

A field is present, but its value is the wrong type (e.g. a string where a
number was expected).

**Not auto-patched.** Coercing an arbitrary wrong-typed value to the right type
is not a safe, meaning-preserving operation in general.

### `UNKNOWN_NODE_KIND`

A scene node's `kind` does not match one of the seven recognized values
(`group`, `mesh`, `camera`, `light`, `text`, `image`, `compositionRef`).

**Not auto-patched, deliberately.** Guessing a replacement `kind` would change
what the node fundamentally *is* (a text node is not a fallback for a broken
camera node); this is exactly the kind of "fix" that could silently produce a
document that parses but no longer means what its author intended. Fix the
`kind` (or the whole node) manually via `update_scene`.

### `INVALID_DISCRIMINATED_UNION`

A discriminated union mismatch other than `UNKNOWN_NODE_KIND` (reserved for
any future discriminated union this package adds beyond scene node `kind`).

**Not auto-patched**, for the same reason as `UNKNOWN_NODE_KIND`.

### `INVALID_ENUM_VALUE`

A field restricted to a fixed set of literal values (e.g. `lightType`, a
transition's `direction`) holds a value outside that set.

**Not auto-patched.** Unlike a numeric range, there is no "nearest" enum value
to clamp to; picking one out of several unrelated options would be a guess.

### `VALUE_OUT_OF_RANGE`

A numeric (or otherwise orderable) value falls outside its allowed minimum or
maximum.

**Auto-patched**: a `"replace"` patch clamping the value to the nearest
allowed bound (nudged one unit further for a strictly-exclusive or integer
bound, so the clamped value itself still passes). A clamp is always safe: by
definition, "the nearest allowed value" lands inside the range, and it is the
least surprising unambiguous interpretation of "this number is out of range."

### `UNRECOGNIZED_FIELD`

An object carries a field name this package's schemas do not recognize (every
object in this package is a `z.strictObject`; no schema silently accepts or
strips an unknown key).

**Auto-patched**: a `"remove"` patch deleting the offending key. Always safe:
the field is, by definition, not part of this shape at all, so removing it
cannot destroy anything the schema considers meaningful. (If the field name
was a typo for a real one, that is still worth fixing by hand; the automatic
patch only removes the unrecognized key, it does not guess which real field
you meant.)

### `UNSUPPORTED_SCHEMA_VERSION`

The document's top-level `schemaVersion` is not the current version this
build of `@cadra/schema` understands.

**Not auto-patched, deliberately.** Rewriting `schemaVersion` alone, without
also migrating `project`'s shape to match (see `migrateSceneDocument`), would
produce a document that parses successfully but no longer means what its
author intended, which is worse than leaving it as a clear, unpatched
failure. Use `migrateSceneDocument` first, then re-validate.

### `INVALID_ASSET_REF`

A field that identifies an externally-resolved asset (`assetRef`,
`geometryRef`, `materialRef`, `fontRef`) is blank, or is padded with
leading/trailing whitespace around otherwise-real content.

**Auto-patched, but only the padded case**: a `"replace"` patch with the
string trimmed. A ref that is blank (empty, or entirely whitespace) has no
real content to recover a fix from - which asset was meant? - and is left
unpatched.

### `INVALID_CROSS_FIELD_RULE`

The general fallback code for any cross-field validation rule that predates
this diagnostic system and does not (yet) carry its own specific code -
transition/direction pairing, strictly-increasing keyframe frame ordering,
audio fade-duration bounds, and so on. Each still carries a full, specific,
hand-written `message` explaining exactly what is wrong.

**Not auto-patched.** These are bespoke, context-dependent rules; there is no
single mechanical fix that applies across all of them.

## Adding a new code

If you add a new structurally-recognizable Zod issue mapping in
`deriveCode`/`enrichIssue`/`deriveSuggestedPatch` (`packages/schema/src/parse.ts`),
add it to `DIAGNOSTIC_CODES` in that same file and document it here. If you add
a new hand-written `.superRefine` cross-field check and want it to carry its
own code (rather than falling back to `INVALID_CROSS_FIELD_RULE`), tag its
`custom` issue with the `cadraDiagnosticCode` params marker (see
`checkAssetRefs` in `parse.ts` for the pattern `INVALID_ASSET_REF` already
uses).
