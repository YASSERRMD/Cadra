import { resolveIconDataUri } from "./icon-resolver.js";

/** Resolves an icon to its `data:` URI, same as `resolveIconDataUri`, cached per unique `(icon, color)` pair (including caching a "not a real icon name" negative result). */
export interface IconResolverCache {
  resolve(icon: string, color: string | undefined): string | undefined;
}

/**
 * A `Map`-backed `IconResolverCache`, wrapping `resolveIconDataUri`
 * (`icon-resolver.ts`) the same way `createRenderLayerCache` wraps
 * `renderLayerToSvg`. Keyed by `JSON.stringify([icon, color])` rather than
 * a hand-picked separator between the two fields, so there is no need to
 * reason about which characters `icon`/`color` could ever contain
 * (`JSON.stringify` already escapes unambiguously). Not content-hashed, for
 * the same reason `EmojiResolverCache` is not: this key is already short
 * and directly comparable, so hashing it would buy nothing.
 */
export function createIconResolverCache(): IconResolverCache {
  const resolved = new Map<string, string | undefined>();

  return {
    resolve(icon: string, color: string | undefined): string | undefined {
      const key = JSON.stringify([icon, color ?? null]);
      if (resolved.has(key)) {
        return resolved.get(key);
      }
      const dataUri = resolveIconDataUri(icon, color);
      resolved.set(key, dataUri);
      return dataUri;
    },
  };
}
