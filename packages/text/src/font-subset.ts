import { hashAssetBytes } from "@cadra/core";
import subsetFont, { type SubsetFontOptions } from "subset-font";

/** Options for `subsetFontToCodePoints`, mirroring `subset-font`'s own options. */
export interface FontSubsetOptions {
  targetFormat?: SubsetFontOptions["targetFormat"];
  preserveNameIds?: readonly number[];
  variationAxes?: SubsetFontOptions["variationAxes"];
}

/**
 * Deterministic cache key for a set of code points, independent of
 * iteration/insertion order and of host byte order (encoded explicitly as
 * little-endian so the key itself is reproducible across machines, not just
 * within one process).
 */
export function codePointSetKey(codePoints: Iterable<number>): string {
  const sorted = Array.from(new Set(codePoints)).sort((a, b) => a - b);
  const bytes = new Uint8Array(sorted.length * 4);
  const view = new DataView(bytes.buffer);
  sorted.forEach((codePoint, index) => {
    view.setUint32(index * 4, codePoint, true);
  });
  return hashAssetBytes(bytes);
}

/**
 * Subsets `bytes` down to only the glyphs needed to render `codePoints`,
 * via `subset-font` (itself backed by HarfBuzz's `hb-subset` wasm build),
 * so the same font bytes plus the same code point set always produce the
 * same subset bytes.
 */
export async function subsetFontToCodePoints(
  bytes: Uint8Array,
  codePoints: Iterable<number>,
  options: FontSubsetOptions = {},
): Promise<Uint8Array> {
  const text = Array.from(new Set(codePoints), (codePoint) => String.fromCodePoint(codePoint)).join(
    "",
  );
  const inputBuffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const subsetBuffer = await subsetFont(inputBuffer, text, {
    targetFormat: options.targetFormat ?? "sfnt",
    preserveNameIds: options.preserveNameIds,
    variationAxes: options.variationAxes,
  });
  return new Uint8Array(subsetBuffer.buffer, subsetBuffer.byteOffset, subsetBuffer.byteLength);
}
