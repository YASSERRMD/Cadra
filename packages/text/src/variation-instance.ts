import type { FontRegistry } from "./font-registry.js";
import { subsetFontToCodePoints } from "./font-subset.js";
import type { ParsedFont } from "./parsed-font.js";

/**
 * Resolves a full axis-tag-to-value pin for every one of `font`'s own
 * variation axes: `requested` supplies whichever axes the caller actually
 * cares about (e.g. just `wght`), and every other axis (if any) is pinned
 * to its own font-declared default rather than left variable.
 */
export function resolveFullVariationPin(
  font: ParsedFont,
  requested: Readonly<Record<string, number>> | undefined,
): Record<string, number> {
  const pin: Record<string, number> = {};
  for (const axis of font.variationAxes) {
    pin[axis.tag] = requested?.[axis.tag] ?? axis.default;
  }
  return pin;
}

/**
 * Bakes `font`'s own variable-font axes down to a fixed instance at
 * `coordinates`, returning static (non-variable) font bytes whose glyph
 * outlines genuinely reflect that instance - not just its advance widths,
 * which HarfBuzz's own instancing (`harfbuzz-shaping.ts`) already gets
 * cheaply without rebaking anything.
 *
 * Reuses `subsetFontToCodePoints`'s own `variationAxes` pin, the same
 * mechanism `@cadra/satori-layer`'s `instanceFontForSatori` already relies
 * on for an unrelated reason (its own bundled font parser cannot read a
 * font with any active `fvar` axis at all). Here, the reason is that
 * `generateMsdfAtlas`'s underlying `msdfgen-wasm` binding has no
 * variation-coordinate parameter of its own at all - the only way to get
 * instance-correct glyph *shapes* into an MSDF atlas is to hand it
 * already-static, already-instanced bytes, since the atlas generator
 * itself has no notion of "which instance" to rasterize.
 *
 * Deterministic: the same font bytes, `codePoints`, and `coordinates`
 * always bake to the same output bytes (HarfBuzz's own subsetter, like
 * every other real shaping step this codebase depends on, is a pure
 * function of its inputs).
 */
export async function bakeVariationInstance(
  font: ParsedFont,
  codePoints: Iterable<number>,
  coordinates: Readonly<Record<string, number>>,
): Promise<Uint8Array> {
  const variationAxes = resolveFullVariationPin(font, coordinates);
  return subsetFontToCodePoints(font.bytes, codePoints, { targetFormat: "sfnt", variationAxes });
}

/**
 * Resolves the font `content` should actually be shaped with: `font`
 * unchanged when `variationAxes` is `undefined` (the common case - no extra
 * work at all), or a freshly baked, subsetted, real outline-instanced font
 * (`bakeVariationInstance` above) re-registered into `fontRegistry` when it
 * is set. Shared by every real `TextNode` render-data preparation site
 * (`@cadra/encode`'s `render-job.ts`, `@cadra/golden-frames`'
 * `render-raster-scene.ts`) rather than duplicated in each, since the logic
 * itself - not just the underlying `bakeVariationInstance` primitive - is
 * identical between them.
 *
 * `variationSourceFont` is the font `bakeVariationInstance` actually pins
 * against - it must have real `variationAxes` populated, which `font` often
 * does not: `createFontRegistry`'s own doc calls out that a caller needing
 * this shaping font to also work in a browser-bundled render page (both
 * current call sites do) has to load it via the `"opentype"` backend, and
 * `parseFontWithOpentype`'s own doc is explicit that this backend "does not
 * populate `variationAxes`" at all (unlike `parseFontWithFontkit`) - baking
 * against `font` itself in that case would silently resolve an *empty* pin
 * (`resolveFullVariationPin` has no axes to iterate), producing byte-identical
 * output regardless of the requested coordinates. Omitted, this falls back
 * to baking against `font` itself, correct only when `font` already carries
 * real axes (e.g. it was itself parsed via `"fontkit"`).
 *
 * Re-registering through `fontRegistry` (content-hash-keyed, see
 * `createFontRegistry`'s own doc) rather than constructing a `ParsedFont`
 * by hand means an identical bake - the same content and resolved
 * coordinates, whether from the same node repeated across frames or two
 * different nodes/callers - is only ever parsed once. The baked result is
 * always a static (non-variable) font (this function's own doc), so
 * re-registering it through an `"opentype"`-backed `fontRegistry`
 * specifically never risks that backend's own well-known `fvar`-parsing
 * crash on a still-variable font (see `@cadra/satori-layer`'s
 * `instanceFontForSatori`, which pins for exactly this same reason).
 */
export async function resolveTextShapingFont(
  fontRegistry: FontRegistry,
  font: ParsedFont,
  content: string,
  variationAxes: Readonly<Record<string, number>> | undefined,
  variationSourceFont?: ParsedFont,
): Promise<ParsedFont> {
  if (variationAxes === undefined) {
    return font;
  }
  const codePoints = Array.from(content, (char) => char.codePointAt(0) as number);
  const bakedBytes = await bakeVariationInstance(variationSourceFont ?? font, codePoints, variationAxes);
  return fontRegistry.registerBytes(bakedBytes).ready;
}
