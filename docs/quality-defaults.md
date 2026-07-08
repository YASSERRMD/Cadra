# Quality defaults and preset library

This guide is for an LLM agent (or a developer) who wants a Cadra scene to
already look professional before touching a single lighting/material/grading
field, and for anyone who needs to override one of those defaults cleanly
once the scene needs its own specific look. It covers every default this
codebase applies automatically, the curated type- and look-preset libraries
built on top of them, and exactly which field to set to opt out of each one.

This is a starting point, not the exhaustive spec: the actual defaults live
in the referenced source files below, and this document can drift from them.
When in doubt, trust the code (`resolveMeshMaterial`, `DEFAULT_LIGHTING_RIG`,
`TYPE_PRESETS`, `LOOK_PRESETS`) over this guide, the same caveat the
[agent authoring guide](agent-authoring-guide.md) gives for the scene-graph
vocabulary itself.

## What renders professionally with zero authoring

A minimal scene - one `mesh`/`model` node and one `text` node, no lights, no
`postProcessing`, no `colorGrading`, no `environment` - already renders at a
professional baseline:

- **Tone mapping**: every render uses ACES Filmic tone mapping and an sRGB
  output color space unconditionally (`applyColorWorkflowDefaults` in
  `packages/renderer/src/three-renderer.ts`). This is not a `Composition`
  field; there is nothing to set to get it, and no way to opt out of it
  short of authoring `colorGrading.exposureStops` to compensate for a
  specific look.
- **Materials**: an inline `material` (`MeshMaterialConfig`) defaults every
  omitted field to a cinematic, physically plausible value - a neutral 70%
  gray `baseColor`, `0.5` `roughness`, `0` `metalness`, and so on (see
  `resolveMeshMaterial` in `packages/core/src/primitives/material.ts`, and
  each field's own doc comment on `MeshMaterialConfig` in
  `packages/core/src/scene-graph/scene-node.ts`). A mesh with no `material`
  at all instead uses `materialRef`'s registry-resolved material, unchanged
  since before this default existed.
- **Lighting**: if a composition's resolved scene state has no `LightNode`
  anywhere in its own node tree and no `environment` configured, the
  renderer adds a small three-point key/fill/rim lighting rig
  (`DEFAULT_LIGHTING_RIG`, `packages/core/src/primitives/look-presets.ts`)
  directly to the render - never to the scene document itself, so
  `parseScene`/`get_scene` never see it. The moment either condition stops
  holding (you author a light, or set `environment`), the fallback rig is
  removed on the very next render. See "Overriding the default lighting
  rig" below for exactly how to opt out.
- **Text**: flat (non-extruded) text glyphs render unlit, so a `text` node
  needs no lighting at all to be fully visible; only `mesh`/`model` geometry
  needs the default lighting rig above.

Phase 73's own golden-frame test (`packages/golden-frames/src/scenes/`)
exercises exactly this "text plus a model, nothing else authored" scene and
checks it against a human-approved reference image, so a future regression
in any of the above is caught the same way every other curated visual
feature in this codebase already is.

## Overriding the default lighting rig

The default lighting rig is intentionally all-or-nothing per composition,
not a per-field default: it either fully applies (zero lights, zero
`environment`) or it does not apply at all. To take over lighting yourself,
do either of:

- Author at least one `light` node anywhere in the composition's own scene
  graph (a bare `LightNode` with `intensity: 0.01` if you genuinely want
  near-darkness - the fallback only checks whether a light node exists
  structurally, not its resolved brightness).
- Set `Composition.environment` (image-based lighting) - the fallback rig
  never engages once an environment is configured, matching how a
  deliberately IBL-only look (e.g. `LOOK_PRESETS.product`) already works.

There is no field on `Composition` to disable the fallback while keeping
zero lights and zero environment: that combination is precisely the "an
author has not gotten to lighting yet" case the fallback exists for.

## Type presets: tasteful text defaults

`TYPE_PRESETS` (`packages/core/src/primitives/type-presets.ts`) bundles
`fontSize`, `transform`, and a `stagger`/`outline`/`glow`/`shadow`
combination for four common on-screen roles:

| Preset              | Role                                                          |
| -------------------- | -------------------------------------------------------------- |
| `title`              | A large, centered title card: a slow word-by-word rise with a soft glow. |
| `lowerThird`         | A broadcast-style lower third: bottom-left, with a drop shadow for legibility over video. |
| `caption`            | A subtitle-style caption: bottom-center, a single quick line-fade (never per-word, which would slow reading down), with an outline. |
| `kineticWordReveal`  | A punchy, energetic word-by-word reveal with an overshooting ease. |

In TypeScript, spread a preset into `Text()`, overriding whatever fields your
scene needs to differ:

```ts
import { Text, TYPE_PRESETS } from "@cadra/core";

const title = Text({ id: "title-1", ...TYPE_PRESETS.title, content: "CADRA" });
const biggerTitle = Text({ id: "title-2", ...TYPE_PRESETS.title, fontSize: 140, content: "CADRA" });
```

Through the `add_text_node` MCP tool, pass `typePreset` instead - any other
field passed alongside it overrides that one field from the preset, exactly
like the TypeScript spread above:

```jsonc
{ "typePreset": "lowerThird", "content": "Jane Doe, Correspondent", "fontSize": 40 }
```

`transform.position` in every preset assumes a typical camera framing (an
origin-facing camera a handful of units back, matching every curated example
scene in this codebase); override `transform` yourself for a different
camera setup, the same way you would override `PBR_PRESETS.brushedMetal`'s
own `baseColor` for a different material.

## Look presets: lighting, post-processing, and grading in one call

`LOOK_PRESETS` (same file as `DEFAULT_LIGHTING_RIG`) bundles a lighting rig,
`postProcessing`, `colorGrading`, and `environment` at the whole-composition
level:

| Preset          | Look                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `cinematic`     | A dramatic key/fill/rim rig plus bloom/vignette/grain: a general-purpose title-card or hero-shot look. |
| `product`       | A soft, even studio rig plus a neutral IBL environment and shallow depth of field: a clean, believable hero-product look. |
| `documentary`   | A naturalistic two-light rig (no rim) with gentle desaturation and grain: a believable interview/observational look. |
| `boldSocial`    | A punchy, high-contrast rig plus a vibrant accent light and a saturated, sharpened grade: built for short-form social video. |
| `elegantTitle`  | A soft, even rig with a gentle bloom and a restrained grade, no vignette: a refined, high-end title-card look. |

Apply one via `applyLookPreset` in TypeScript, or the `apply_look_preset` MCP
tool:

```ts
import { applyLookPreset, createIdGenerator } from "@cadra/core";

const lit = applyLookPreset(composition, "documentary", createIdGenerator("my-seed"));
```

A look preset **overwrites** `postProcessing`/`colorGrading`/`environment`
outright (never deep-merges with whatever the composition already had), and
**adds** its lights as new tracks alongside any existing ones - it is a
starting point to author from, not something that reads or preserves prior
state. Apply it first, then layer your own `update_scene` edits on top if
you need to diverge from it.

## Right-to-left and complex-script safety

Every `TYPE_PRESETS` entry groups its own `stagger` by `"word"` or `"line"`,
never `"character"`/`"grapheme"`. `TextStaggerConfig`'s grouping ranks units
by their own reading-order index (`TextUnit.index`, from real HarfBuzz
shaping plus bidi resolution - see that type's own doc in
`packages/core/src/scene-graph/scene-node.ts`), not by visual (left-to-right
array) order, so `"forward"` always means first-read to last-read regardless
of script. `packages/schema/examples/rtl-latin-lower-third.scene.json`
exercises exactly this with real Arabic content.

One documented exception: `TextPathConfig.alignment` (placing text along a
curve) is deliberately **visual**-order, not reading-order, since a curve's
own "start" is a property of its geometry, not of the text's reading
direction. See `TextPathAlignment`'s own doc comment for exactly what this
means for right-to-left content on a path, and how to get the opposite
behavior.

## Summary: every override point

| Default                          | Where it lives                                              | How to override it                                                  |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Tone mapping / output color space | `applyColorWorkflowDefaults` (`@cadra/renderer`, hardcoded)   | Not overridable directly; compensate via `colorGrading.exposureStops`. |
| Per-field material defaults       | `resolveMeshMaterial` (`@cadra/core`)                         | Set the specific `MeshMaterialConfig` field yourself.                  |
| Default lighting rig              | `DEFAULT_LIGHTING_RIG` (`@cadra/core`), applied by `@cadra/renderer` | Author any one `light` node, or set `Composition.environment`.  |
| Type presets                      | `TYPE_PRESETS` (`@cadra/core`)                                | Spread and override in TypeScript, or pass the same field alongside `typePreset` via `add_text_node`. |
| Look presets                      | `LOOK_PRESETS` (`@cadra/core`)                                | Apply, then `update_scene` the specific field afterward; a second `applyLookPreset` call overwrites `postProcessing`/`colorGrading`/`environment` again. |
