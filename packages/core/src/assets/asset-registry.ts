import type { ContentHash } from "./content-hash.js";

/**
 * Resolves a content hash to an already-loaded resource of type `T`. Keyed
 * by content hash (not url) so two different urls that happen to load
 * byte-identical content resolve to the exact same registered resource,
 * never a duplicate.
 *
 * Consistent in spirit with `packages/renderer`'s `GeometryRegistry` /
 * `MaterialRegistry` from Phase 6 (a plain `resolve` lookup callers must not
 * assume ownership of), extended here with `register`/`has` since this
 * registry is the thing populated by the loading pipeline itself, not a
 * fixed pool seeded ahead of time.
 */
export interface AssetRegistry<T> {
  /** Stores `resource` under `hash`, replacing any previous entry for that hash. */
  register(hash: ContentHash, resource: T): void;
  /** Looks up the resource registered under `hash`, if any. */
  resolve(hash: ContentHash): T | undefined;
  /** Reports whether a resource is already registered under `hash`. */
  has(hash: ContentHash): boolean;
}

/**
 * A simple in-memory `AssetRegistry`, backed by a `Map`. The default
 * implementation for both this package's generic use and
 * `packages/renderer`'s concrete loaders.
 */
export function createInMemoryAssetRegistry<T>(): AssetRegistry<T> {
  const resources = new Map<ContentHash, T>();

  return {
    register(hash: ContentHash, resource: T): void {
      resources.set(hash, resource);
    },
    resolve(hash: ContentHash): T | undefined {
      return resources.get(hash);
    },
    has(hash: ContentHash): boolean {
      return resources.has(hash);
    },
  };
}
