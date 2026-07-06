import { type Project, resolveSceneAtFrame } from "@cadra/core";

import type { IsFrameReadyFn } from "../transport.js";
import type { AssetKindOfFn, VideoReadinessCache } from "./video-readiness.js";
import { isSceneStateVideoReady } from "./video-readiness.js";

/** Options accepted by `createVideoFrameReadyCheck`. */
export interface CreateVideoFrameReadyCheckOptions {
  /** The project whose composition's video-backed content readiness is checked. */
  project: Project;
  /** Which of `project`'s compositions to check readiness against. */
  compositionId: string;
  /** The readiness cache populated by the prefetcher/seek-gating decode queue. */
  cache: VideoReadinessCache;
  /** Resolves an `assetRef` to its `AssetKind`. */
  assetKindOf: AssetKindOfFn;
}

/**
 * Builds an `IsFrameReadyFn` (see `../transport.js`) that reports `frame` as
 * ready only once every video-backed node `resolveSceneAtFrame` resolves at
 * that frame has its exact needed content already decoded/cached per
 * `cache`.
 *
 * `resolveSceneAtFrame` is itself memoized per `(project, compositionId,
 * frame)` (see that function's own doc), so calling this repeatedly for the
 * same frame (once per tick, while playback stalls on it) is cheap: it never
 * re-walks the scene graph from scratch beyond the first call for a given
 * frame.
 *
 * Meant to be passed directly as `Transport`'s `isFrameReady` construction
 * option, activating the tick-loop buffering path from Phase 13 (previously
 * dormant behind the "always ready" default) for genuinely video-driven
 * stalls, not by modifying `transport.ts` itself.
 */
export function createVideoFrameReadyCheck(
  options: CreateVideoFrameReadyCheckOptions,
): IsFrameReadyFn {
  const { project, compositionId, cache, assetKindOf } = options;
  return (frame: number) => {
    const sceneState = resolveSceneAtFrame(project, compositionId, frame);
    return isSceneStateVideoReady(sceneState, cache, assetKindOf);
  };
}
