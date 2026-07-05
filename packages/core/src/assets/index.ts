/**
 * Environment-agnostic asset pipeline primitives: content hashing, asset
 * descriptors, the generic asset registry, the asset-readiness gate, and
 * deterministic video-frame-to-timestamp math.
 *
 * `packages/renderer`'s `src/assets/` builds the concrete, browser-API-based
 * loaders and dedup orchestration on top of these; nothing here touches a
 * browser/DOM/network API, so it is fully testable in plain Node.
 */

export type { AssetDescriptor, AssetKind } from "./asset-descriptor.js";
export type { AssetRegistry } from "./asset-registry.js";
export { createInMemoryAssetRegistry } from "./asset-registry.js";
export type { ContentHash } from "./content-hash.js";
export { hashAssetBytes } from "./content-hash.js";
export { videoSampleTimestamp } from "./video-sample-timestamp.js";
export type { Pending } from "./wait-for-assets.js";
export { waitForAssets } from "./wait-for-assets.js";
