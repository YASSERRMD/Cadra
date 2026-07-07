import { resolveTwemojiSvgBytes } from "./twemoji-assets.js";

/** Encodes raw SVG bytes as a `data:` URI Satori's `graphemeImages`/`loadAdditionalAsset` accept as an image source, needing no I/O of its own to resolve further. */
function svgBytesToDataUri(bytes: Buffer): string {
  return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
}

/**
 * Resolves one emoji grapheme cluster (already ZWJ/skin-tone/flag-joined,
 * see `twemoji-assets.ts`) to a `data:` URI of its Twemoji artwork, or
 * `undefined` if this exact sequence has no corresponding asset. Uncached;
 * see `emoji-resolver-cache.ts` for the cached entry point every real
 * caller (`fallback-font-resolver.ts`) actually uses.
 */
export function resolveEmojiDataUri(segment: string): string | undefined {
  const bytes = resolveTwemojiSvgBytes(segment);
  return bytes === undefined ? undefined : svgBytesToDataUri(bytes);
}
