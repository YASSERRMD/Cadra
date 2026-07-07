import { hashAssetBytes } from "@cadra/core";
import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

import type { FetchBytes } from "../assets/types.js";

/**
 * Parses raw Radiance HDR (`.hdr`) bytes into a real, GPU-ready
 * equirectangular `THREE.DataTexture`, via Three.js's own `HDRLoader`
 * (RGBE decoding, no network/file I/O of its own - `bytes` must already be
 * the full file contents). `.mapping` is set to
 * `EquirectangularReflectionMapping` so the result is immediately usable
 * with `PMREMGenerator.fromEquirectangular` (see
 * `ThreeRendererLike.createEnvironmentMap` in `../three-renderer.ts`) or
 * directly as `scene.background`.
 *
 * EXR support is deliberately not included: `three/addons/loaders/EXRLoader.js`
 * exists and could be wired in identically if a real need for it arises, but
 * HDR is both the more common interchange format for environment maps and
 * the one this function's own tests can construct valid, minimal fixture
 * bytes for entirely in-memory (a hand-built Radiance file is a simple,
 * documented ASCII-header-plus-RGBE-scanlines format; EXR's own container
 * format is not).
 */
export function parseHdrEnvironment(bytes: Uint8Array): THREE.DataTexture {
  const loader = new HDRLoader();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const texture = loader.createDataTexture(buffer);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

/** Dependencies `loadHdrEnvironment` needs: fetching the file's raw bytes. */
export interface LoadHdrEnvironmentDependencies {
  fetchBytes: FetchBytes;
}

/** Result of loading an HDR environment: the decoded texture plus the content hash of its source bytes. */
export interface LoadedHdrEnvironment {
  texture: THREE.DataTexture;
  hash: string;
}

/**
 * Loads and decodes an HDR environment map from `url`, mirroring
 * `../assets/image-loader.ts`'s `loadImage` shape exactly: every actual I/O
 * step is injected via `deps`, so this function itself is pure
 * orchestration (fetch bytes, hash them, parse), with no caching or
 * single-flight dedup of its own (that is `asset-loader-orchestrator.ts`'s
 * job, same as for images).
 */
export async function loadHdrEnvironment(
  url: string,
  deps: LoadHdrEnvironmentDependencies,
): Promise<LoadedHdrEnvironment> {
  const bytes = await deps.fetchBytes(url);
  const hash = hashAssetBytes(bytes);
  const texture = parseHdrEnvironment(bytes);
  return { texture, hash };
}
