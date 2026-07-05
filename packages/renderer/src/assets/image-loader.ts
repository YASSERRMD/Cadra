import { hashAssetBytes } from "@cadra/core";

import type { FetchBytes } from "./types.js";

/**
 * Decodes fetched image bytes into a usable image resource. Real
 * implementations reach for browser APIs (`createImageBitmap`, or an
 * `HTMLImageElement`/`Image()` load), which do not exist in this headless
 * test environment; always injected so tests supply a fake instead.
 */
export type DecodeImage = (bytes: Uint8Array) => Promise<ImageBitmap>;

/** Dependencies `loadImage` needs: fetching bytes and decoding them into an image. */
export interface LoadImageDependencies {
  fetchBytes: FetchBytes;
  decodeImage: DecodeImage;
}

/** Result of loading an image: the decoded resource plus the content hash of its source bytes. */
export interface LoadedImage {
  image: ImageBitmap;
  hash: string;
}

/**
 * Loads and decodes an image from `url`.
 *
 * Every actual I/O/decode step is injected via `deps`, so this function
 * itself is pure orchestration: fetch bytes, hash them (for the content-hash
 * dedup the asset-loader orchestrator performs), decode. It does not itself
 * do any caching or single-flight dedup; see `./asset-loader-orchestrator.ts`
 * for that layer.
 */
export async function loadImage(url: string, deps: LoadImageDependencies): Promise<LoadedImage> {
  const bytes = await deps.fetchBytes(url);
  const hash = hashAssetBytes(bytes);
  const image = await deps.decodeImage(bytes);
  return { image, hash };
}
