/**
 * @cadra/headless
 *
 * Deterministic headless render and orchestration for Cadra scenes, driving
 * @cadra/renderer outside of a browser tab.
 *
 * `renderComposition` is the deterministic render loop: given a `Project`/
 * `compositionId` and an already-`init`-ed `PixelReadableRenderer`, it walks
 * every integer frame from `0` to `durationInFrames - 1` in order, at a
 * fixed timestep with no wall clock and no unseeded randomness anywhere in
 * the loop, yielding each frame's read-back pixels as an async generator.
 * See its own module doc for the full contract (asset-readiness gating,
 * progress reporting, `AbortSignal` cancellation, and renderer disposal).
 *
 * Converting each `RenderedFrame`'s pixel buffer into a `VideoFrame` (via
 * WebCodecs) and encoding the result to a real video container is
 * `@cadra/encode`'s job (Phases 19-22), not this one's: this package's own
 * scope ends at "byte-for-byte reproducible pixel buffers, in order," for
 * the direct in-process rendering path.
 *
 * Phase 23 additively exports the MVP server-side render path:
 * `renderCompositionHeadlessServer` launches a headless browser (real
 * Playwright/Chromium via `launchPlaywrightHeadlessBrowser` by default),
 * bundles a browser-side entry script (`bundleBrowserEntry`, esbuild) that
 * runs the *entire* render/capture/encode/mux pipeline inside the page
 * (real GPU/software rendering, real WebCodecs, real muxing), and streams
 * the encoded result back out to a Node-side destination as it is
 * produced, via an `exposeFunction` write/close/progress bridge. Every
 * attempt renders the whole composition from scratch (no partial-progress
 * resume; see `renderCompositionHeadlessServer`'s own doc for why a clean
 * retry is correct here), retrying up to a configurable attempt count on
 * any crash/timeout/error before surfacing
 * `HeadlessServerRenderFailedError`. `browser-launcher.ts` (the injectable
 * `BrowserLauncher` seam) and the actual browser-side entry file (living in
 * `@cadra/encode`, not here; see `bundle-browser-entry.ts`'s own doc for
 * why) are what let most of this package's own tests exercise this whole
 * flow against a fake browser, with only a small number of real
 * end-to-end tests launching an actual browser.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/headless";

export type {
  BrowserLauncher,
  HeadlessBrowserLike,
  HeadlessConsoleMessageLike,
  HeadlessPageLike,
  LaunchHeadlessBrowserOptions,
} from "./browser-launcher.js";
export { DEFAULT_GPU_LAUNCH_ARGS, launchPlaywrightHeadlessBrowser } from "./browser-launcher.js";
export type { BundleBrowserEntryOptions } from "./bundle-browser-entry.js";
export { BROWSER_ENTRY_GLOBAL_NAME, bundleBrowserEntry } from "./bundle-browser-entry.js";
export type {
  GetPendingAssetsFn,
  OnProgressFn,
  RenderCompositionOptions,
  RenderedFrame,
} from "./render-composition.js";
export { CompositionNotFoundForRenderError, renderComposition } from "./render-composition.js";
export type {
  HeadlessServerFileWriteStreamLike,
  HeadlessServerLogLine,
  OnLogFn,
  RenderCompositionHeadlessServerOptions,
} from "./render-composition-headless-server.js";
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RENDER_TIMEOUT_MS,
  HeadlessServerBrowserCrashedError,
  HeadlessServerRenderFailedError,
  HeadlessServerRenderTimeoutError,
  renderCompositionHeadlessServer,
} from "./render-composition-headless-server.js";
