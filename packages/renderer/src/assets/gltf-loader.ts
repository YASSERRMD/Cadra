import { hashAssetBytes } from "@cadra/core";

import type { FetchBytes } from "./types.js";

/**
 * A parsed GLTF scene/model resource. Opaque here on purpose: this
 * directory does not depend on any particular GLTF-parsing library's result
 * shape (e.g. three.js's `GLTFLoader` output), only on being able to cache
 * and hand back whatever a real parser produces.
 */
export type GltfAsset = object;

/**
 * Parses fetched GLTF/GLB bytes into a usable model resource. A real
 * implementation reaches for a GLTF parser (e.g. three.js's `GLTFLoader`),
 * which needs a DOM-ish environment this headless test environment does not
 * provide; always injected so tests supply a fake instead.
 *
 * Deliberately thin: no scene-graph node kind references a GLTF asset yet,
 * so this loader's job stops at "typed, loadable, cached, testable" rather
 * than modeling scene-graph splicing, materials, or animations, which
 * belongs to whichever later phase adds a GLTF-referencing node kind.
 */
export type ParseGltf = (bytes: Uint8Array) => Promise<GltfAsset>;

/** Dependencies `loadGltf` needs: fetching bytes and parsing them into a model resource. */
export interface LoadGltfDependencies {
  fetchBytes: FetchBytes;
  parseGltf: ParseGltf;
}

/** Result of loading a GLTF asset: the parsed resource plus the content hash of its source bytes. */
export interface LoadedGltf {
  model: GltfAsset;
  hash: string;
}

/** Loads and parses a GLTF/GLB model from `url`. Mirrors `loadImage`'s fetch-hash-decode shape. */
export async function loadGltf(url: string, deps: LoadGltfDependencies): Promise<LoadedGltf> {
  const bytes = await deps.fetchBytes(url);
  const hash = hashAssetBytes(bytes);
  const model = await deps.parseGltf(bytes);
  return { model, hash };
}
