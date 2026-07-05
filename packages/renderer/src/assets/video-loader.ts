import { hashAssetBytes, videoSampleTimestamp } from "@cadra/core";

import type { FetchBytes } from "./types.js";

/**
 * Decodes fetched video bytes into a seekable video source. Real
 * implementations reach for an `HTMLVideoElement` (or a WebCodecs decoder),
 * neither of which exists in this headless test environment; always
 * injected so tests supply a fake instead.
 */
export type DecodeVideo = (bytes: Uint8Array) => Promise<VideoSource>;

/**
 * A decoded, seekable video source. Opaque here on purpose: this package
 * does not need to know its concrete shape, only that `sampleAtTimestamp`
 * (below) can act on it.
 */
export type VideoSource = object;

/**
 * Samples a frame of `source` at an exact timestamp (in seconds) and returns
 * whatever per-kind resource represents that sampled frame (e.g. a decoded
 * `ImageBitmap`). Deliberately timestamp-based, never based on a video
 * element's own real-time playback position: real video seeking cannot be
 * exercised headlessly, and driving sampling off wall-clock playback would
 * make a render's output depend on when it happened to run rather than on
 * `frame`/`fps` alone.
 */
export type SampleAtTimestamp = (source: VideoSource, timestamp: number) => Promise<ImageBitmap>;

/** Dependencies `loadVideo` needs: fetching bytes and decoding them into a seekable source. */
export interface LoadVideoDependencies {
  fetchBytes: FetchBytes;
  decodeVideo: DecodeVideo;
}

/** Result of loading a video: the seekable source plus the content hash of its source bytes. */
export interface LoadedVideo {
  source: VideoSource;
  hash: string;
}

/**
 * Loads and decodes a video from `url`, returning a seekable `VideoSource`.
 * Mirrors `loadImage`'s shape: fetch bytes, hash them, decode; no caching or
 * single-flight dedup here (see `./asset-loader-orchestrator.ts`).
 */
export async function loadVideo(url: string, deps: LoadVideoDependencies): Promise<LoadedVideo> {
  const bytes = await deps.fetchBytes(url);
  const hash = hashAssetBytes(bytes);
  const source = await deps.decodeVideo(bytes);
  return { source, hash };
}

/** Dependencies `sampleVideoFrame` needs: only the injectable sampling primitive. */
export interface SampleVideoFrameDependencies {
  sampleAtTimestamp: SampleAtTimestamp;
}

/**
 * Samples `source` at the exact timestamp corresponding to `frame` at
 * `fps`, using `@cadra/core`'s `videoSampleTimestamp` (itself `frameToTime`)
 * rather than any notion of the video's own playback clock. This is what
 * makes video sampling deterministic and race-free in a headless render:
 * the same `(frame, fps)` pair always requests the same timestamp,
 * regardless of when or how fast rendering happens to run.
 */
export function sampleVideoFrame(
  source: VideoSource,
  frame: number,
  fps: number,
  deps: SampleVideoFrameDependencies,
): Promise<ImageBitmap> {
  const timestamp = videoSampleTimestamp(frame, fps);
  return deps.sampleAtTimestamp(source, timestamp);
}
