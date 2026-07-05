import { hashAssetBytes } from "@cadra/core";

import type { FetchBytes } from "./types.js";

/**
 * Decodes fetched audio bytes into a usable audio buffer. A real
 * implementation reaches for `AudioContext.decodeAudioData`, unavailable in
 * this headless test environment; always injected so tests supply a fake
 * instead.
 *
 * Deliberately thin: full audio frame-sync (aligning decoded audio to the
 * composition's frame clock during playback/render) is explicitly Phase
 * 16's job. This loader's job stops at "typed, loadable, cached, testable",
 * the same capability-only treatment as `./font-loader.ts`/`./gltf-loader.ts`.
 */
export type DecodeAudio = (bytes: Uint8Array) => Promise<AudioBuffer>;

/** Dependencies `loadAudio` needs: fetching bytes and decoding them into an audio buffer. */
export interface LoadAudioDependencies {
  fetchBytes: FetchBytes;
  decodeAudio: DecodeAudio;
}

/** Result of loading audio: the decoded buffer plus the content hash of its source bytes. */
export interface LoadedAudio {
  buffer: AudioBuffer;
  hash: string;
}

/** Loads and decodes audio from `url`. Mirrors `loadImage`'s fetch-hash-decode shape. */
export async function loadAudio(url: string, deps: LoadAudioDependencies): Promise<LoadedAudio> {
  const bytes = await deps.fetchBytes(url);
  const hash = hashAssetBytes(bytes);
  const buffer = await deps.decodeAudio(bytes);
  return { buffer, hash };
}
