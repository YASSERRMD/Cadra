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
