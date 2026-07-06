/**
 * Web Worker-backed rendering: moves `Renderer.renderFrame`'s actual GPU
 * work off the main thread via `OffscreenCanvas`, so a host application's
 * main thread (e.g. `@cadra/player`'s `Transport`/`mountPreview`) stays
 * responsive to input and layout while frames render. The same worker path
 * is reused by `@cadra/headless`'s deterministic capture mode (rendering off
 * the main thread there too, without a visible canvas at all).
 *
 * `createWorkerRenderer` is the main-thread `Renderer` implementation:
 * it satisfies the exact same `Renderer` interface as the direct
 * in-process renderer from `../create-renderer.js`, so it is a drop-in
 * replacement wherever a `Renderer` is expected, no caller-side changes
 * required. It additionally satisfies `PixelReadableRenderer` (see
 * `../pixel-readable-renderer.js`) via its own `readPixels()`, posting a
 * `readPixels` request and resolving with the `pixels` payload of its
 * `readPixelsAck`. `createBestAvailableRenderer` picks between the worker-
 * backed and direct in-process renderer automatically, based on whether
 * `OffscreenCanvas`/`transferControlToOffscreen` are available in the
 * current environment.
 *
 * `./worker-host.js` is the message-handling core that runs inside the
 * worker itself, driving a real `Renderer` constructed there; `./worker-entry.js`
 * is the actual `new Worker(url)` entry-point module wiring that host up to
 * the worker's global scope. On `readPixels`, the host requires its
 * constructed renderer to also implement `PixelReadableRenderer`, responding
 * with an `error` (via `WorkerRendererNotPixelReadableError`) otherwise.
 * `./worker-protocol.js` defines the typed request/response message shapes
 * both sides speak, and `./scene-state-diff.js` implements the positional
 * layer-diffing optimization `createWorkerRenderer`/`worker-host.js` use to
 * avoid re-sending unchanged scene-node subtrees every frame.
 */

export {
  detectOffscreenCanvasSupport,
  type OffscreenCanvasDetector,
} from "./offscreen-detection.js";
export type { SceneStateDiffTracker, WorkerLayerCache } from "./scene-state-diff.js";
export {
  createSceneStateDiffTracker,
  createWorkerLayerCache,
  diffSceneStateLayers,
  reconstructSceneState,
  UnknownUnchangedLayerError,
} from "./scene-state-diff.js";
export type {
  PostResponseFn,
  RendererFactory,
  WorkerHost,
  WorkerHostOptions,
} from "./worker-host.js";
export {
  createWorkerHost,
  installWorkerHostMessageListener,
  WorkerHostNotInitializedError,
  WorkerRendererNotPixelReadableError,
} from "./worker-host.js";
export type {
  DiffedLayer,
  DiffedSceneState,
  UnchangedLayerRef,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol.js";
export { isUnchangedLayerRef } from "./worker-protocol.js";
export type {
  CreateBestAvailableRendererOptions,
  CreateWorkerFn,
  CreateWorkerRendererOptions,
  WorkerLike,
} from "./worker-renderer.js";
export {
  createBestAvailableRenderer,
  createWorkerRenderer,
  WorkerRendererError,
  WorkerRendererNotInitializedError,
  WorkerRendererRequiresCanvasElementError,
} from "./worker-renderer.js";
