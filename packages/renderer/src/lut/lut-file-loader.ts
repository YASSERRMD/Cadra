import { hashAssetBytes } from "@cadra/core";
import * as THREE from "three";
import { LUTCubeLoader } from "three/addons/loaders/LUTCubeLoader.js";

import type { FetchBytes } from "../assets/types.js";

/**
 * Parses a real `.cube` file's own text contents into a real, GPU-ready
 * `THREE.Data3DTexture`, via Three.js's own `LUTCubeLoader.parse` (no
 * network/file I/O of its own - `text` must already be the full file
 * contents, mirroring `parseHdrEnvironment`'s own "parsing is pure, fetching
 * is injected" split in `../environment/hdr-environment-loader.ts`).
 */
export function parseCubeLut(text: string): THREE.Data3DTexture {
  const loader = new LUTCubeLoader();
  return loader.parse(text).texture3D;
}

/** Dependencies `loadLutFromCube` needs: fetching the file's raw bytes. */
export interface LoadLutFromCubeDependencies {
  fetchBytes: FetchBytes;
}

/** Result of loading a `.cube` LUT: the decoded texture plus the content hash of its source bytes. */
export interface LoadedCubeLut {
  texture: THREE.Data3DTexture;
  hash: string;
}

/**
 * Loads and decodes a real `.cube` LUT file from `url`, mirroring
 * `loadHdrEnvironment`'s own shape exactly (`../environment/
 * hdr-environment-loader.ts`): every actual I/O step is injected via
 * `deps`, so this function itself is pure orchestration (fetch bytes, hash
 * them, decode as UTF-8 text, parse), with no caching or single-flight
 * dedup of its own (that is `asset-loader-orchestrator.ts`'s job, same as
 * for images and HDR environments). The result is meant to populate a
 * caller's own custom `LutRegistry` (`./lut-registry.ts`) ahead of time,
 * never resolved synchronously mid-render.
 */
export async function loadLutFromCube(url: string, deps: LoadLutFromCubeDependencies): Promise<LoadedCubeLut> {
  const bytes = await deps.fetchBytes(url);
  const hash = hashAssetBytes(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  return { texture: parseCubeLut(text), hash };
}
