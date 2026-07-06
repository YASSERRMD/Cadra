/**
 * @cadra/renderer
 *
 * Backend-agnostic rendering abstraction: selects WebGPU when available and
 * falls back to WebGL2 transparently, so downstream Cadra packages depend
 * only on the `Renderer` interface exported here, never on Three.js
 * directly.
 *
 * `Renderer.renderFrame` accepts the real `SceneState` from `@cadra/core`'s
 * timeline resolver: `ThreeRenderer` reconciles it into a live Three.js tree
 * internally (see `./reconciler` and `three-renderer.ts`), so callers never
 * see or construct a Three.js type themselves.
 *
 * `./reconciler` additively exports the scene-graph-to-Three.js reconciler:
 * given a `SceneNode` tree, it produces and incrementally updates a live
 * `THREE.Object3D` tree. Unlike everything above, its exports legitimately
 * expose Three.js types, since mapping to Three.js is its entire purpose.
 *
 * `./assets` additively exports the asset loading and caching pipeline:
 * per-`AssetKind` loaders (image, video, font, GLTF, audio), the
 * single-flight/content-hash-deduping orchestrator, deterministic video
 * frame sampling, and the `renderWhenAssetsReady` readiness gate. Every real
 * I/O/decode primitive is injectable, per its own module doc.
 *
 * `./worker` additively exports Web Worker-backed rendering:
 * `createWorkerRenderer` moves `renderFrame`'s GPU work off the main thread
 * via `OffscreenCanvas`, satisfying the exact same `Renderer` interface as
 * the direct in-process renderer above, and `createBestAvailableRenderer`
 * picks between the two based on `OffscreenCanvas` availability. See that
 * module's own doc for the worker message protocol and scene-state diffing
 * it uses internally.
 *
 * `PixelReadableRenderer` additively extends `Renderer` with `readPixels()`,
 * for callers (e.g. `@cadra/headless`'s deterministic capture mode) that
 * need to read back a rendered frame's pixels: `Renderer` itself is
 * unchanged, so every existing live-preview consumer is unaffected. Both
 * rendering paths satisfy it: `createPixelReadableRenderer` wraps the
 * direct, in-process renderer with an injected pixel-read primitive (real
 * GPU pixel readback is not exercisable in this headless Node/Vitest
 * environment, so it is always injected, matching every other GPU-touching
 * seam in this package), and `createWorkerRenderer` implements it directly
 * via the worker protocol's `readPixels`/`readPixelsAck` message pair.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/renderer";

export type { AssetLoaderOrchestrator, Hashed } from "./assets/asset-loader-orchestrator.js";
export { createAssetLoaderOrchestrator } from "./assets/asset-loader-orchestrator.js";
export type { LoadAudioDependencies, LoadedAudio } from "./assets/audio-loader.js";
export { loadAudio } from "./assets/audio-loader.js";
export type { LoadedFont, LoadFontDependencies } from "./assets/font-loader.js";
export { loadFont } from "./assets/font-loader.js";
export type { GltfAsset, LoadedGltf, LoadGltfDependencies } from "./assets/gltf-loader.js";
export { loadGltf } from "./assets/gltf-loader.js";
export type { DecodeImage, LoadedImage, LoadImageDependencies } from "./assets/image-loader.js";
export { loadImage } from "./assets/image-loader.js";
export { renderWhenAssetsReady } from "./assets/render-when-ready.js";
export type { FetchBytes, LoadedAsset } from "./assets/types.js";
export type {
  DecodeVideo,
  LoadedVideo,
  LoadVideoDependencies,
  SampleAtTimestamp,
  SampleVideoFrameDependencies,
  VideoSource,
} from "./assets/video-loader.js";
export { loadVideo, sampleVideoFrame } from "./assets/video-loader.js";
export type { WebGpuDetector } from "./capability-detection.js";
export type { CreateRendererOptions } from "./create-renderer.js";
export { createRenderer } from "./create-renderer.js";
export type { PixelBuffer, PixelReadableRenderer } from "./pixel-readable-renderer.js";
export type {
  CreatePixelReadableRendererOptions,
  ReadPixelsFn,
} from "./pixel-readable-three-renderer.js";
export {
  createPixelReadableRenderer,
  PixelReadableRendererNotInitializedError,
} from "./pixel-readable-three-renderer.js";
export type {
  NodeFactoryContext,
  OwnedResources,
  Reconciler,
  ReconcilerOptions,
} from "./reconciler/index.js";
export type { GeometryRegistry, MaterialRegistry } from "./reconciler/index.js";
export {
  createDefaultGeometryRegistry,
  createDefaultMaterialRegistry,
  createReconciler,
  DEFAULT_GEOMETRY_REFS,
  DEFAULT_MATERIAL_REFS,
} from "./reconciler/index.js";
export type {
  Renderer,
  RendererBackend,
  RendererCapabilities,
  RenderSize,
  RenderTarget,
} from "./renderer.js";
export type {
  CreateBestAvailableRendererOptions,
  CreateWorkerFn,
  CreateWorkerRendererOptions,
  DiffedLayer,
  DiffedSceneState,
  OffscreenCanvasDetector,
  PostResponseFn,
  RendererFactory,
  SceneStateDiffTracker,
  UnchangedLayerRef,
  WorkerHost,
  WorkerHostOptions,
  WorkerLayerCache,
  WorkerLike,
  WorkerRequest,
  WorkerResponse,
} from "./worker/index.js";
export {
  createBestAvailableRenderer,
  createSceneStateDiffTracker,
  createWorkerHost,
  createWorkerLayerCache,
  createWorkerRenderer,
  detectOffscreenCanvasSupport,
  diffSceneStateLayers,
  installWorkerHostMessageListener,
  isUnchangedLayerRef,
  reconstructSceneState,
  UnknownUnchangedLayerError,
  WorkerHostNotInitializedError,
  WorkerRendererError,
  WorkerRendererNotInitializedError,
  WorkerRendererNotPixelReadableError,
  WorkerRendererRequiresCanvasElementError,
} from "./worker/index.js";
