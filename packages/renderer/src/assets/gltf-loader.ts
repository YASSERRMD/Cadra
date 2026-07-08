import { hashAssetBytes } from "@cadra/core";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { FetchBytes } from "./types.js";

/**
 * A parsed GLTF scene/model resource. Opaque here on purpose: this
 * directory does not depend on any particular GLTF-parsing library's result
 * shape (e.g. three.js's `GLTFLoader` output), only on being able to cache
 * and hand back whatever a real parser produces. `@cadra/renderer`'s own
 * `LoadedModel` (`assets/model-registry.ts`) describes the concrete
 * `{scene, animations}` shape a `"model"` scene node (Phase 69) actually
 * needs to render; `createDefaultParseGltf`'s own result structurally
 * satisfies it.
 */
export type GltfAsset = object;

/**
 * Parses fetched GLTF/GLB bytes into a usable model resource. Always
 * injected (see `createDefaultParseGltf`, below, for the real
 * implementation) so tests can supply a fake instead of needing the DOM-ish
 * environment - `TextDecoder`/`Blob`/`URL.createObjectURL`, for a GLB with
 * external or embedded-base64 image textures - a real GLTF parser generally
 * needs.
 */
export type ParseGltf = (bytes: Uint8Array) => Promise<GltfAsset>;

/**
 * The real `ParseGltf`, backed by three.js's own `GLTFLoader`. Constructs
 * one `GLTFLoader` and reuses it across every call (mirroring
 * `createDefaultEnvironmentRegistry`'s own "build the expensive/stateful
 * thing once" treatment), since a loader instance holds no per-parse state.
 *
 * `parseAsync`'s own `path` argument (its second) is only consulted for
 * resolving *external* relative references (a separate `.bin` file, or
 * separate texture files); a self-contained `.glb` with everything embedded
 * - the only kind this project's own tests construct, via `GLTFExporter`'s
 * `binary: true` mode - never needs one, so this always passes `""`.
 *
 * `bytes.buffer.slice(...)` (not `bytes.buffer` directly): `bytes` may be a
 * view over a larger, differently-offset `ArrayBuffer` (e.g. a subarray);
 * slicing to its own exact `byteOffset`/`byteLength` is what actually
 * reproduces just the bytes `bytes` itself represents, regardless of what
 * its backing buffer looks like.
 */
export function createDefaultParseGltf(): ParseGltf {
  const loader = new GLTFLoader();
  return async (bytes: Uint8Array): Promise<GltfAsset> => {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const gltf = await loader.parseAsync(arrayBuffer, "");
    return { scene: gltf.scene, animations: gltf.animations };
  };
}

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
