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
