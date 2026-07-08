/**
 * Concrete, browser-API-shaped asset loading for the five `AssetKind`s
 * (`@cadra/core`'s content hashing, `AssetRegistry`, and `waitForAssets` are
 * the environment-agnostic primitives this builds on).
 *
 * Every real I/O/decode primitive (fetching bytes, decoding an image,
 * sampling a video at a timestamp, parsing a font/GLTF, decoding audio) is
 * injectable, following `../three-renderer.ts`'s dependency-injection
 * pattern, so this directory is fully testable in headless Node against
 * fakes: nothing here can be exercised against a real browser/GPU in this
 * repo's test environment. `createAssetLoaderOrchestrator` layers
 * single-flight and content-hash dedup on top of any one per-kind loader;
 * `renderWhenAssetsReady` is the readiness gate a render must go through
 * before it can use any of these loaders' output.
 *
 * Image and video get the fullest treatment (video additionally exposes
 * deterministic frame-to-timestamp sampling via `sampleVideoFrame`); font,
 * GLTF, and audio are intentionally thinner; see each loader's own module
 * doc for why.
 */

export type { AssetLoaderOrchestrator, Hashed } from "./asset-loader-orchestrator.js";
export { createAssetLoaderOrchestrator } from "./asset-loader-orchestrator.js";
export type { LoadAudioDependencies, LoadedAudio } from "./audio-loader.js";
export { loadAudio } from "./audio-loader.js";
export type { LoadedFont, LoadFontDependencies } from "./font-loader.js";
export { loadFont } from "./font-loader.js";
export type { GltfAsset, LoadedGltf, LoadGltfDependencies, ParseGltf } from "./gltf-loader.js";
export { createDefaultParseGltf, loadGltf } from "./gltf-loader.js";
export type { DecodeImage, LoadedImage, LoadImageDependencies } from "./image-loader.js";
export { loadImage } from "./image-loader.js";
export type { LoadedModel, ModelRegistry, MutableModelRegistry } from "./model-registry.js";
export { createDefaultModelRegistry, createInMemoryModelRegistry } from "./model-registry.js";
export { renderWhenAssetsReady } from "./render-when-ready.js";
export type { FetchBytes, LoadedAsset } from "./types.js";
export type {
  DecodeVideo,
  LoadedVideo,
  LoadVideoDependencies,
  SampleAtTimestamp,
  SampleVideoFrameDependencies,
  VideoSource,
} from "./video-loader.js";
export { loadVideo, sampleVideoFrame } from "./video-loader.js";
