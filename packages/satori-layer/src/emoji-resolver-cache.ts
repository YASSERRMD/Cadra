import { resolveEmojiDataUri } from "./emoji-resolver.js";

/** Resolves an emoji grapheme to its `data:` URI, same as `resolveEmojiDataUri`, cached per unique grapheme (including caching a "no asset for this one" negative result) so repeated frames/renders of the same emoji never re-read or re-encode it. */
export interface EmojiResolverCache {
  resolve(segment: string): string | undefined;
}

/**
 * A `Map`-backed `EmojiResolverCache`, wrapping `resolveEmojiDataUri`
 * (`emoji-resolver.ts`) the same way `createRenderLayerCache` wraps
 * `renderLayerToSvg`. Not `computeXCacheKey` plus `hashAssetBytes`-hashed
 * the way `RenderLayerCache`/`SvgRasterCache` key their own (much larger)
 * inputs: a grapheme cluster is already a short, directly-comparable
 * string, so hashing it would buy nothing over using it as the `Map` key
 * directly, mirroring `computeSatoriLayerRenderKey`'s own choice not to
 * hash its own already-small, already-deterministic key material either.
 */
export function createEmojiResolverCache(): EmojiResolverCache {
  const resolved = new Map<string, string | undefined>();

  return {
    resolve(segment: string): string | undefined {
      if (resolved.has(segment)) {
        return resolved.get(segment);
      }
      const dataUri = resolveEmojiDataUri(segment);
      resolved.set(segment, dataUri);
      return dataUri;
    },
  };
}
