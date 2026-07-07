# Agent authoring guide

This guide is for an LLM agent (or a developer) writing a Cadra scene
document by hand, or debugging one that failed to parse. It explains the
envelope shape, the vocabulary of primitives/properties/easings you can use,
where to find the exhaustive machine-readable versions of both, and what a
parse diagnostic looks like when something is wrong.

This is a starting point, not the exhaustive spec. The JSON Schema and the
capability manifest (both described below) are generated directly from this
package's own Zod schemas and `@cadra/core`'s types, so they can never drift
from what `parseScene` actually accepts; this document can. When in doubt,
trust those over this guide.

## The fastest path: `describeCadraContract()`

If you can execute code against `@cadra/schema`, call this one function to
get everything below in a single, versioned object:

```ts
import { describeCadraContract } from "@cadra/schema";

const contract = describeCadraContract();
// contract.schemaVersion  -> the contract version every field below matches
// contract.jsonSchema     -> the full JSON Schema for a scene document
// contract.capabilities   -> primitives, properties, easings (see below)
// contract.examples       -> a handful of real, valid SceneDocuments
```

Everything is regenerated fresh on every call from this package's own
schemas, so it can never go stale relative to `parseScene`. If you cannot run
code (e.g. you only have this repository checked out as text), read
`packages/schema/src/json-schema.ts`, `packages/schema/src/capabilities.ts`,
and the example files under `packages/schema/examples/*.scene.json` directly.

## The envelope

Every Cadra scene document is a JSON object with exactly two top-level keys:

```json
{
  "schemaVersion": 1,
  "project": { "...": "a full Project" }
}
```

- `schemaVersion` must be the literal number the current build of
  `@cadra/schema` implements (`CURRENT_SCHEMA_VERSION`, currently `1`).
  Anything else is rejected immediately with a dedicated diagnostic naming
  the unsupported version, before the rest of the document is even checked.
- `project` is the full scene: an `id`, a `name`, and a list of
  `compositions`. Nothing besides `schemaVersion` and `project` is allowed at
  the top level; an extra key here is rejected, not silently ignored.

A `Project` contains one or more `Composition`s. Each `Composition` is a
fixed `fps`, a fixed integer `durationInFrames`, a fixed pixel `width`/
`height`, and one or more `tracks` (plus optional `activeCameraTrack` and
`audioTracks`). Each `track` holds an ordered list of `clips`. Each `clip` has
an integer `startFrame` and `durationInFrames` (both counted in frames, never
wall-clock time or seconds), a `node` (the scene-graph subtree this clip
contributes), and an optional `transitionIn` (`fade`, `wipe` with a
`direction`, or `crossDissolve`).

Read `packages/schema/examples/title-card.scene.json` for the smallest
complete example, and `packages/schema/examples/multi-track-transition.scene.json`
for one that uses multiple tracks, a transition, and an audio track together.

## Primitives: the scene node vocabulary

Every node in a `Composition`'s scene graph has a `kind`, and `kind` must be
one of exactly seven values: `group`, `mesh`, `camera`, `light`, `text`,
`image`, `compositionRef`. Every node, regardless of `kind`, shares:

- `id` (a unique string within the project)
- `transform` (`position`/`rotation`/`scale`, each a `Vector3`, i.e. a
  3-element number tuple; rotation is Euler radians in intrinsic XYZ order)
- `visible` (a boolean)
- `children` (nested nodes of any kind)
- an optional human-readable `name`

Beyond the shared fields, each `kind` adds its own:

| `kind`           | Adds                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `group`          | nothing; exists only to organize children                                  |
| `mesh`           | `geometryRef`, `materialRef` (asset registry ids)                          |
| `camera`         | `fov`, `near`, `far`, `target` (a `Vector3` look-at)                       |
| `light`          | `lightType` (`ambient`/`directional`/`point`/`spot`), `color`, `intensity` |
| `text`           | `content`, optional `fontRef`, `fontSize`, `color`                         |
| `image`          | `assetRef`                                                                 |
| `compositionRef` | `compositionId` (embeds another composition by id)                         |

`color` fields are `ColorRGBA`: a 4-element tuple, each channel in the
inclusive range `0` to `1`, not `0` to `255`.

Every one of `sceneNodeKindSchema`'s seven values, and every field listed
above, is enforced by `z.strictObject`: an unrecognized `kind`, or a field
that does not belong to the `kind` you used (e.g. `geometryRef` on a `text`
node), is rejected as a parse error, never silently dropped or coerced.

## Properties: what can be keyframed

Many fields above are not just a plain value: they are a `Property<T>`,
meaning you may supply either a plain value of type `T`, or a keyframe track
that animates it over time:

```json
{
  "type": "keyframeTrack",
  "keyframes": [
    { "frame": 0, "value": [1, 1, 1, 0], "easing": "easeInOutCubic" },
    { "frame": 30, "value": [1, 1, 1, 1] }
  ]
}
```

`frame` is an integer, and every keyframe in a track must have a strictly
greater `frame` than the one before it (no duplicates, no out-of-order
entries). `easing` is optional per keyframe and defaults to `"linear"`; it
names how this keyframe blends into the next one.

Exactly which dot-paths on each `kind` are genuinely keyframeable (as opposed
to structural fields like `id`/`kind`/`children` that a keyframe system would
never target) is listed per-primitive in the capability manifest
(`generateCapabilityManifest()`, or `contract.capabilities.primitives` from
`describeCadraContract()`). As a quick reference:

| `kind`                                     | Animatable dot-paths                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `group`, `mesh`, `image`, `compositionRef` | `transform.position`, `transform.rotation`, `transform.scale`, `visible`                      |
| `camera`                                   | `transform.position`, `transform.rotation`, `transform.scale`, `target`, `fov`, `near`, `far` |
| `light`                                    | `transform.position`, `transform.rotation`, `transform.scale`, `color`, `intensity`           |
| `text`                                     | `transform.position`, `transform.rotation`, `transform.scale`, `color`, `fontSize`, `visible` |

## Easings: the full list

A keyframe's `easing` must be one of exactly 14 names:

`linear`, `easeInCubic`, `easeOutCubic`, `easeInOutCubic`, `easeInExpo`,
`easeOutExpo`, `easeInOutExpo`, `easeInBack`, `easeOutBack`, `easeInOutBack`,
`easeInElastic`, `easeOutElastic`, `easeInOutElastic`, `hold`.

Thirteen of these are continuous curves (some function from progress to
progress); `hold` is different; it is a step, not a curve: the value stays
at the starting keyframe's value for the whole segment, then jumps instantly
to the next keyframe's value at its frame. Use `hold` for a `visible`
track (a boolean has no meaningful continuous blend between `true` and
`false`) or for any other discrete, non-blending change.

The capability manifest's `easings` list tags each name with whether it is
continuous, so you never have to hardcode this distinction yourself.

## Transitions

A `clip`'s optional `transitionIn` is one of:

- `{ "type": "fade", "durationInFrames": N }`
- `{ "type": "crossDissolve", "durationInFrames": N }`
- `{ "type": "wipe", "durationInFrames": N, "direction": "left" | "right" | "up" | "down" }`

`direction` is required for `wipe` and forbidden for the other two types;
`durationInFrames` must be a positive integer for all three. Omitting
`transitionIn` entirely means an instant cut.

## Codecs: not part of this package's contract

You may notice `CapabilityManifest` has an optional `codecs` field. This
package (`@cadra/schema`) never populates it: real codec preference and
support data lives in `@cadra/encode`, a package `@cadra/schema` does not and
should not depend on (schema is a foundational package; encode sits above
it). If you are working with a higher-level tool that legitimately depends
on both (e.g. the MCP server), it may merge real codec data into a manifest
it hands you; if you called `generateCapabilityManifest()` directly from
`@cadra/schema`, expect `codecs` to be `undefined`.

## Reading a diagnostic

When `parseScene(input)` (or `sceneDocumentSchema.safeParse(input)`) rejects
a document, you get back `{ success: false, diagnostics: SceneParseDiagnostic[] }`.
Each diagnostic is:

```ts
interface SceneParseDiagnostic {
  path: string; // e.g. "project.compositions[0].tracks[0].clips[0].node.kind"
  message: string; // human-readable explanation
  code: string; // stable, machine-comparable error class, e.g. "UNKNOWN_NODE_KIND"
  expected?: string; // short description of what was actually expected here
  received?: unknown; // the actual offending value, when JSON-serializable
  suggestedFix?: string; // a short, actionable suggestion (prose, for a human/agent to read)
  suggestedPatch?: { op: "replace" | "add" | "remove"; path: string; value?: unknown };
}
```

`path` always names the exact offending field, using dotted-property and
bracketed-index notation, so you can jump straight to it without searching
the whole document. `code` is stable across releases; branch on it directly
instead of pattern-matching `message` (which is prose). See
[`docs/diagnostic-codes.md`](./diagnostic-codes.md) for the exhaustive list of
codes and what each one means. For example:

```json
{
  "path": "project.compositions[0].tracks[0].clips[0].node.kind",
  "message": "Invalid discriminator value. Expected 'group' | 'mesh' | 'camera' | 'light' | 'text' | 'image' | 'compositionRef'",
  "code": "UNKNOWN_NODE_KIND",
  "expected": "one of: group, mesh, camera, light, text, image, compositionRef",
  "suggestedFix": "Set project.compositions[0].tracks[0].clips[0].node.kind to one of the supported values for 'kind': group, mesh, camera, light, text, image, compositionRef."
}
```

`expected`/`suggestedFix` are plain, descriptive strings meant for you (an
agent or a human) to read and act on. `suggestedPatch`, when present, is a
single machine-appliable edit (in the same `path` format) that resolves that
specific diagnostic - but it is only ever populated for error classes with a
genuinely safe, unambiguous automatic fix (a missing field with a
conservative known-safe default, an out-of-range number clamped to its
nearest bound, an unrecognized field removed, a padded asset ref trimmed); an
unknown node `kind`, for instance, never gets one, since guessing a
replacement `kind` could silently change what the node fundamentally is.

Call the `repair_scene` MCP tool (`@cadra/mcp-server`) to automatically apply
every `suggestedPatch` a persisted scene's current diagnostics carry and
re-validate; it only persists the result if it now actually passes, and
reports back whatever diagnostics remain (including any it could not safely
patch) in `remainingDiagnostics` either way. You can also apply a single patch
yourself via `applyPatchAtPath` (`@cadra/schema`) if you want finer control
than repairing everything at once.

Some diagnostics have no `expected`/`suggestedFix`/`suggestedPatch` at all:
cross-field rules (a `wipe` transition missing its `direction`, a keyframe
track with out-of-order frames, an audio fade longer than its own clip)
already carry a complete, specific, hand-written `message` explaining exactly
what is wrong, with nothing further to mechanically add or safely automate.

## If you're building programmatically instead of hand-writing JSON

`@cadra/agent-sdk` provides a fluent builder (`scene(...).composition(...).add(...).build()`)
that never requires you to hand-author the raw JSON shape at all, and whose
`.build()` always validates the assembled document through this same
`parseScene` before returning it. If validation fails, `.build()` throws a
`SceneBuildError` carrying the exact same `SceneParseDiagnostic[]` described
above as `error.diagnostics`. Prefer the builder over hand-writing JSON when
you can; fall back to this guide when you need to read or debug the raw
document shape directly.
