import type { ParsedFont } from "@cadra/text";
import { subsetFontToCodePoints } from "@cadra/text";

/**
 * Resolves a full axis-tag to value pin for every one of `font`'s own
 * variation axes: `requested` supplies whichever axes the caller cares
 * about, and every other axis (if any) is pinned to its own font-declared
 * default - never left variable.
 *
 * This matters because Satori cannot render a variable font at all: it
 * parses fonts with its own bundled `opentype.js` fork, which throws
 * (`Cannot read properties of undefined`, inside its `fvar` axis-name
 * parsing) on any font that still has so much as one active variation
 * axis, verified empirically against this codebase's own fixture fonts
 * (both an 8-axis and a 2-axis variable font). Pinning every single axis
 * (not just the ones a caller happens to mention) is what removes the
 * `fvar` table's remaining variability entirely and resolves this.
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
 * Prepares one font for Satori: subsets it down to exactly `text`'s own
 * code points (Satori embeds glyph outlines directly into the output SVG,
 * so a smaller subset means smaller output) and, if it is a variable font,
 * pins every variation axis (see `resolveFullVariationPin`) so Satori's own
 * font parser can read it at all. A static font (no variation axes) is
 * subset only, unaffected by the pinning step (an empty pin has nothing to
 * apply). Deterministic: the same font bytes, `text`, and
 * `variationCoordinates` always subset to the same output bytes (HarfBuzz's
 * subsetter, like every other real shaping step this codebase depends on,
 * is a pure function of its inputs).
 */
export async function instanceFontForSatori(
  font: ParsedFont,
  text: string,
  variationCoordinates?: Readonly<Record<string, number>>,
): Promise<Uint8Array> {
  const codePoints = Array.from(text, (char) => char.codePointAt(0) as number);
  const variationAxes = resolveFullVariationPin(font, variationCoordinates);
  return subsetFontToCodePoints(font.bytes, codePoints, {
    targetFormat: "sfnt",
    variationAxes,
  });
}
