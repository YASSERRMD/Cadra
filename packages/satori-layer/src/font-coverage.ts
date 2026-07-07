import type { SatoriLayerFont } from "./render-layer-to-svg.js";

/** Every Unicode code point `text` is made of, by code point (not UTF-16 code unit - `Array.from` iterates a string by code point). */
export function codePointsOf(text: string): number[] {
  return Array.from(text, (char) => char.codePointAt(0) as number);
}

/**
 * Whether `font` has a glyph for at least one code point in `text`: a low
 * bar (not "covers all of `text`") deliberately, since
 * `fallback-font-resolver.ts` hands this hook the full concatenated text of
 * every distinct missing "word" sharing one script/locale bucket, which a
 * single fallback font need not cover in its entirety to still be worth
 * adding to Satori's own font pool for whichever characters it does have.
 */
export function fontCoversAnyCodePoint(font: SatoriLayerFont, text: string): boolean {
  return codePointsOf(text).some((codePoint) => font.font.characterSet.has(codePoint));
}
