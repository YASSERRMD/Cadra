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
 *
 * `ThreeRenderer`/`ThreeRendererDependencies`/`defaultThreeRendererDependencies`
 * are additively exported (Phase 24) so a caller outside this package can
 * construct a `ThreeRenderer` with its own substituted `createWebGpuRenderer`
 * factory, the same injection seam this package's own tests already use
 * internally to swap in a fake. This is what lets `@cadra/headless`'s
 * experimental native-GPU headless render path (`createNativeGpuHeadlessRenderer`,
 * clearly marked experimental) inject a real native `GPUDevice` (from the
 * `webgpu` npm package, no browser) into a real `ThreeRenderer` instead of
 * writing a second, disconnected scene-graph-to-Three.js pipeline: it reuses
 * this exact same reconciler/opacity/camera-resolution logic, differing only
 * in how the underlying `THREE.WebGPURenderer` is constructed and which
 * `RenderTarget`/`GPUCanvasContext` it is handed. See that package's own
 * `render-frame-native-gpu.ts` module doc for the full design and its
 * documented platform caveats.
 *
 * `./gizmo` additively exports `attachTransformGizmo` (Phase 40), which
 * attaches a real `three/addons/controls/TransformControls` gizmo to a
 * reconciled node for interactive move/rotate/scale handles in a live
 * viewport. Its own exported signature stays entirely free of Three.js
 * types (its `renderer` parameter is the plain `Renderer` interface, and its
 * `onTransformChange` callback hands back a plain `@cadra/core` `Transform`),
 * even though its *implementation* imports the real, internal `ThreeRenderer`
 * class to do the actual work; see that module's own doc for the full
 * boundary rationale.
 *
 * `./picking` additively exports `pickNodeAtPoint` (Phase 40), the inverse
 * lookup a viewport's own click-to-select handler needs: given a point in
 * normalized device coordinates, raycasts into the renderer's live scene and
 * returns the `SceneNode.id` of whatever was hit (or `undefined`), using the
 * same `Object3D.name`-by-id tagging `attachTransformGizmo` relies on. Same
 * Three.js-free exported signature, same internal `ThreeRenderer`-narrowing
 * implementation.
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
export type { GltfAsset, LoadedGltf, LoadGltfDependencies, ParseGltf } from "./assets/gltf-loader.js";
export { createDefaultParseGltf, loadGltf } from "./assets/gltf-loader.js";
export type { DecodeImage, LoadedImage, LoadImageDependencies } from "./assets/image-loader.js";
export { loadImage } from "./assets/image-loader.js";
export type { LoadedModel, ModelRegistry, MutableModelRegistry } from "./assets/model-registry.js";
export { createDefaultModelRegistry, createInMemoryModelRegistry } from "./assets/model-registry.js";
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
export type { EnvironmentRegistry } from "./environment/environment-registry.js";
export { createDefaultEnvironmentRegistry, DEFAULT_ENVIRONMENT_REFS } from "./environment/environment-registry.js";
export type { LoadedHdrEnvironment, LoadHdrEnvironmentDependencies } from "./environment/hdr-environment-loader.js";
export { loadHdrEnvironment, parseHdrEnvironment } from "./environment/hdr-environment-loader.js";
export type {
  AttachedTransformGizmo,
  AttachTransformGizmoOptions,
  TransformGizmoMode,
} from "./gizmo/attach-transform-gizmo.js";
export { attachTransformGizmo } from "./gizmo/attach-transform-gizmo.js";
export type { LoadedCubeLut, LoadLutFromCubeDependencies } from "./lut/lut-file-loader.js";
export { loadLutFromCube, parseCubeLut } from "./lut/lut-file-loader.js";
export type { LutRegistry } from "./lut/lut-registry.js";
export { createDefaultLutRegistry, DEFAULT_LUT_REFS } from "./lut/lut-registry.js";
export type {
  NormalizedDeviceCoordinates,
  PickNodeAtPointOptions,
} from "./picking/pick-node-at-point.js";
export { pickNodeAtPoint } from "./picking/pick-node-at-point.js";
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
export type {
  GeometryRegistry,
  MaterialRegistry,
  MutableTextureRegistry,
  TextureRegistry,
} from "./reconciler/index.js";
export {
  createDataTexture,
  createDefaultGeometryRegistry,
  createDefaultMaterialRegistry,
  createDefaultTextureRegistry,
  createImageTexture,
  createInMemoryTextureRegistry,
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
  MutableSatoriLayerRenderRegistry,
  SatoriLayerRenderEntry,
  SatoriLayerRenderRegistry,
} from "./svg-layer/satori-layer-render-registry.js";
export {
  computeSatoriLayerRenderKey,
  createInMemorySatoriLayerRenderRegistry,
} from "./svg-layer/satori-layer-render-registry.js";
export type {
  MutableTextRenderRegistry,
  TextRenderEntry,
  TextRenderRegistry,
} from "./text/text-render-registry.js";
export {
  computeTextNodeRenderKey,
  createInMemoryTextRenderRegistry,
} from "./text/text-render-registry.js";
export type { ThreeRendererDependencies, ThreeRendererFactory } from "./three-renderer.js";
export {
  applyProductionWebGl2Behavior,
  applyProductionWebGpuBehavior,
  defaultThreeRendererDependencies,
  RendererNotInitializedError,
  ThreeRenderer,
} from "./three-renderer.js";
export type {
  MutableVideoFrameRegistry,
  VideoFrameRegistry,
  VideoFrameRenderEntry,
} from "./video-layer/video-frame-registry.js";
export {
  computeVideoFrameCacheKey,
  computeVideoFrameRenderKey,
  createInMemoryVideoFrameRegistry,
} from "./video-layer/video-frame-registry.js";
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
