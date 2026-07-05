import { hashAssetBytes } from "@cadra/core";

import type { FetchBytes } from "./types.js";

/**
 * Parses fetched font bytes into a usable font resource. A real
 * implementation reaches for `FontFace`, unavailable in this headless test
 * environment; always injected so tests supply a fake instead.
 *
 * Deliberately thin: no scene-graph node kind consumes a loaded font yet, so
 * this loader's job stops at "typed, loadable, cached, testable" rather than
 * modeling glyph layout or any deeper font behavior, which belongs to
 * whichever later phase adds text-with-real-fonts rendering.
 */
export type ParseFont = (bytes: Uint8Array) => Promise<FontFace>;

/** Dependencies `loadFont` needs: fetching bytes and parsing them into a font resource. */
export interface LoadFontDependencies {
  fetchBytes: FetchBytes;
  parseFont: ParseFont;
}

/** Result of loading a font: the parsed resource plus the content hash of its source bytes. */
export interface LoadedFont {
  font: FontFace;
  hash: string;
}

/** Loads and parses a font from `url`. Mirrors `loadImage`'s fetch-hash-decode shape. */
export async function loadFont(url: string, deps: LoadFontDependencies): Promise<LoadedFont> {
  const bytes = await deps.fetchBytes(url);
  const hash = hashAssetBytes(bytes);
  const font = await deps.parseFont(bytes);
  return { font, hash };
}
