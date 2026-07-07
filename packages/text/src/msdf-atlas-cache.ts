import { type AssetRegistry, type ContentHash, createInMemoryAssetRegistry, hashAssetBytes } from "@cadra/core";

import { codePointSetKey } from "./font-subset.js";
import { generateMsdfAtlas, type MsdfAtlas, type MsdfAtlasOptions } from "./msdf-atlas.js";
import type { ParsedFont } from "./parsed-font.js";

const DEFAULT_OPTIONS_KEY_FIELDS = {
  fontSize: 42,
  range: 4,
  maxWidth: 2048,
  maxHeight: 2048,
  padding: 2,
} satisfies Required<MsdfAtlasOptions>;

/**
 * Deterministic cache key for one atlas generation request: the font's own
 * content hash, plus `codePointSetKey` reused verbatim over the glyph id set
 * (a glyph id, like a code point, is just a non-negative integer; the
 * existing order/duplicate-independent key works unchanged), plus the
 * resolved (default-filled) options, so requesting the same glyphs with
 * options left at their defaults hashes identically to requesting them with
 * those same values passed explicitly.
 */
export function computeMsdfAtlasCacheKey(
  font: ParsedFont,
  usedGlyphIds: Iterable<number>,
  options: MsdfAtlasOptions = {},
): ContentHash {
  const resolvedOptions = { ...DEFAULT_OPTIONS_KEY_FIELDS, ...options };
  const optionsKey = [
    resolvedOptions.fontSize,
    resolvedOptions.range,
    resolvedOptions.maxWidth,
    resolvedOptions.maxHeight,
    resolvedOptions.padding,
  ].join(":");
  const glyphSetKey = codePointSetKey(usedGlyphIds);
  return hashAssetBytes(new TextEncoder().encode(`${font.contentHash}:${glyphSetKey}:${optionsKey}`));
}

export interface MsdfAtlasCache {
  /** Returns the cached atlas for this exact (font, glyph set, options) request, generating and caching it if this is the first time it has been asked for. */
  getOrGenerate(
    font: ParsedFont,
    usedGlyphIds: ReadonlySet<number>,
    options?: MsdfAtlasOptions,
  ): Promise<MsdfAtlas>;
  has(cacheKey: ContentHash): boolean;
}

/**
 * Content-hashed cache over `generateMsdfAtlas`, so the same font plus the
 * same set of used glyphs plus the same options is generated only once per
 * process, no matter how many scene nodes or frames reference it.
 */
export function createMsdfAtlasCache(): MsdfAtlasCache {
  const registry: AssetRegistry<Promise<MsdfAtlas>> = createInMemoryAssetRegistry<Promise<MsdfAtlas>>();

  return {
    async getOrGenerate(
      font: ParsedFont,
      usedGlyphIds: ReadonlySet<number>,
      options: MsdfAtlasOptions = {},
    ): Promise<MsdfAtlas> {
      const cacheKey = computeMsdfAtlasCacheKey(font, usedGlyphIds, options);
      const cached = registry.resolve(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const pending = generateMsdfAtlas(font, usedGlyphIds, options);
      registry.register(cacheKey, pending);
      return pending;
    },
    has: (cacheKey: ContentHash) => registry.has(cacheKey),
  };
}
