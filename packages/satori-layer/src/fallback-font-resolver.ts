import type { SatoriOptions } from "satori";

import type { EmojiResolverCache } from "./emoji-resolver-cache.js";
import { fontCoversAnyCodePoint } from "./font-coverage.js";
import type { SatoriLayerFont } from "./render-layer-to-svg.js";
import { instanceFontForSatori } from "./satori-font-instancing.js";
import { sharedEmojiResolverCache } from "./shared-emoji-resolver-cache.js";

/** The exact shape `satori()`'s own `SatoriOptions.loadAdditionalAsset` accepts, named here so this module's own return type stays structurally pinned to Satori's, without needing `FontOptions`'s own (differently-named, `Font`) export. */
type LoadAdditionalAsset = NonNullable<SatoriOptions["loadAdditionalAsset"]>;

/** The locale bucket Satori itself invokes `loadAdditionalAsset` under for missing emoji graphemes (as opposed to a real BCP-47-ish locale, or `"unknown"`, for ordinary missing-glyph text). Verified against Satori's own (undocumented) source: `segment` under this bucket is always exactly one already grapheme-segmented cluster. */
const EMOJI_LOCALE_BUCKET = "emoji";

/**
 * Builds the `loadAdditionalAsset` hook `renderLayerToSvg` passes to Satori:
 * on-demand web font fallback plus emoji resolution, both driven by
 * Satori's own lazy "only ask for what a font actually failed to cover"
 * mechanism (see this module's own reverse-engineered notes on
 * `EMOJI_LOCALE_BUCKET`).
 *
 * For the `"emoji"` bucket, `segment` is one grapheme cluster: resolved via
 * `emojiCache` (Twemoji artwork, see `emoji-resolver.ts`) to a `data:` URI
 * string, which Satori merges into its own live `graphemeImages` map. No
 * asset for that exact sequence resolves to `[]` (Satori then simply has no
 * image for that grapheme, the same graceful "render nothing new" outcome
 * an unresolved `TextRenderRegistry`/`SatoriLayerRenderRegistry` entry gets
 * elsewhere in this renderer).
 *
 * For every other bucket, `segment` is the full concatenated text every
 * "primary" font (`renderLayerToSvg`'s own `options.fonts`) failed to
 * cover: every `fallbackFonts` entry covering at least one of its code
 * points (see `fontCoversAnyCodePoint`) is subset (`instanceFontForSatori`,
 * the same on-demand, content-addressed-by-the-font-registry-itself
 * subsetting Phase 41's own primary font pipeline uses) against that same
 * shared text and added to Satori's pool; a `fallbackFonts` entry covering
 * none of it is skipped entirely, so a large fallback pool costs nothing
 * for text it turns out not to be needed for.
 */
export function createLoadAdditionalAsset(
  fallbackFonts: readonly SatoriLayerFont[],
  emojiCache: EmojiResolverCache = sharedEmojiResolverCache,
): LoadAdditionalAsset {
  return async (languageCode, segment) => {
    if (languageCode === EMOJI_LOCALE_BUCKET) {
      const dataUri = emojiCache.resolve(segment);
      return dataUri ?? [];
    }

    const covering = fallbackFonts.filter((font) => fontCoversAnyCodePoint(font, segment));
    return Promise.all(
      covering.map(async (layerFont) => ({
        name: layerFont.family,
        data: Buffer.from(await instanceFontForSatori(layerFont.font, segment, layerFont.variationCoordinates)),
        weight: layerFont.weight ?? 400,
        style: layerFont.style ?? ("normal" as const),
      })),
    );
  };
}
