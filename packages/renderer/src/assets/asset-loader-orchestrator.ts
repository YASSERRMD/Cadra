import type { AssetDescriptor, AssetRegistry, ContentHash } from "@cadra/core";

import type { LoadedAsset } from "./types.js";

/** The minimum shape any per-kind loader result must have for the orchestrator to dedupe it. */
export interface Hashed {
  hash: ContentHash;
}

/**
 * Loads assets described by an `AssetDescriptor`, deduping two independent
 * ways so identical inputs never produce redundant work or redundant
 * registered resources:
 *
 * - Single-flight: two concurrent `load()` calls for the exact same
 *   `descriptor.url`, made before the first resolves, share one in-flight
 *   promise. The underlying loader function runs exactly once for that url,
 *   not twice.
 * - Content-hash: once a load resolves, its content hash is checked against
 *   `registry`. If a resource is already registered under that hash (e.g.
 *   two different urls that happen to serve byte-identical content), the
 *   already-registered resource is reused and no second entry is stored;
 *   otherwise the newly-loaded resource is registered under its hash.
 *
 * Generic over `T` (a per-kind loader's result, e.g. `LoadedImage`), so one
 * orchestrator implementation serves every `AssetKind`: construct one per
 * kind, each wrapping that kind's own loader function (`loadImage`,
 * `loadVideo`, ...) and its own `AssetRegistry<T>`.
 */
export interface AssetLoaderOrchestrator<T> {
  /** Loads the asset `descriptor` describes, deduping by in-flight url and by content hash. */
  load(descriptor: AssetDescriptor): LoadedAsset<T>;
}

/**
 * Creates an `AssetLoaderOrchestrator`.
 *
 * @param registry - Where deduped, loaded resources are stored, keyed by
 *   content hash.
 * @param loadByUrl - The underlying per-kind loader, e.g. `(url) =>
 *   loadImage(url, deps)`. Called at most once per distinct url that is not
 *   already in flight.
 */
export function createAssetLoaderOrchestrator<T extends Hashed>(
  registry: AssetRegistry<T>,
  loadByUrl: (url: string) => Promise<T>,
): AssetLoaderOrchestrator<T> {
  // Tracks requests currently in flight, keyed by url, so a second load()
  // call for the same url before the first settles reuses the same promise
  // rather than invoking loadByUrl again. Cleared once the request settles
  // (success or failure) so a later, fresh load() call for the same url
  // after this one finishes triggers a real reload rather than replaying a
  // stale result forever.
  const inFlightByUrl = new Map<string, Promise<T>>();

  function load(descriptor: AssetDescriptor): LoadedAsset<T> {
    const { url } = descriptor;
    const existing = inFlightByUrl.get(url);
    if (existing) {
      return { ready: existing };
    }

    const ready = loadByUrl(url)
      .then((result) => dedupeByContentHash(registry, result))
      .finally(() => {
        inFlightByUrl.delete(url);
      });

    inFlightByUrl.set(url, ready);
    return { ready };
  }

  return { load };
}

/**
 * Registers `result` under its content hash unless a resource is already
 * registered there, in which case the already-registered resource is
 * returned instead so two byte-identical loads never end up as two
 * separate registry entries.
 */
function dedupeByContentHash<T extends Hashed>(registry: AssetRegistry<T>, result: T): T {
  const existing = registry.resolve(result.hash);
  if (existing !== undefined) {
    return existing;
  }
  registry.register(result.hash, result);
  return result;
}
