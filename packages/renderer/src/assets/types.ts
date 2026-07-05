/**
 * Fetches the raw bytes for `url`. The one real network/filesystem I/O
 * primitive every loader depends on; always injected so tests never perform
 * real I/O, following Phase 5's `ThreeRendererDependencies` pattern of
 * pushing every actual browser/GPU primitive behind a swappable function.
 */
export type FetchBytes = (url: string) => Promise<Uint8Array>;

/**
 * A resource that has finished loading (or is in the process of loading) and
 * reports its own completion via `ready`, matching `@cadra/core`'s `Pending`
 * shape so any collection of these can be passed straight to `waitForAssets`.
 */
export interface LoadedAsset<T> {
  /** Resolves once the decoded resource is available; rejects on load failure. */
  ready: Promise<T>;
}
