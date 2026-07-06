import { type Project, resolveSceneAtFrame } from "@cadra/core";

import type { Transport } from "../transport.js";
import type { DecodeQueue } from "./decode-video-frame.js";
import type { AssetKindOfFn } from "./video-readiness.js";
import { findVideoBackedFrames } from "./video-readiness.js";

/** Options accepted by `attachVideoFramePrefetch`. */
export interface AttachVideoFramePrefetchOptions {
  /** The project whose composition's frames get prefetched. */
  project: Project;
  /** Which of `project`'s compositions to prefetch against. */
  compositionId: string;
  /** The transport whose `frameChanged` event drives the prefetch window. */
  transport: Transport;
  /** Where decoded frames get queued/deduped and, on success, marked ready. */
  decodeQueue: DecodeQueue;
  /** Resolves an `assetRef` to its `AssetKind`. */
  assetKindOf: AssetKindOfFn;
  /**
   * How many frames on either side of the current playhead to warm.
   * Defaults to `3`: enough to absorb a tick's worth of jitter and a small
   * scrub without needing to wait, without warming so wide a window that
   * ordinary playback wastes decode work on frames unlikely to be reached.
   */
  windowSize?: number;
}

/** Imperative handle returned by `attachVideoFramePrefetch`. */
export interface VideoFramePrefetch {
  /** Unsubscribes from `transport`'s `frameChanged` event. Idempotent. */
  dispose(): void;
}

/**
 * Proactively decodes video content for frames near `transport`'s current
 * playhead, so that by the time playback or a nearby seek actually reaches
 * them, `IsFrameReadyFn`/the seek-gating readiness check already returns
 * true and nothing needs to wait.
 *
 * Hooks `frameChanged` (fired on every actual frame change, both ordinary
 * playback advancement and a completed seek) and, for each frame in
 * `[frame - windowSize, frame + windowSize]` clamped to
 * `[0, durationInFrames - 1]`, resolves its `SceneState` and queues a decode
 * for every video-backed node found. Fire-and-forget by construction:
 * `decodeQueue.ensureDecoded`'s returned promise is never awaited here, and
 * any rejection is swallowed (a failed prefetch just means that frame stays
 * not-ready until something else, e.g. a later seek, retries it) so
 * prefetching itself can never block or delay playback/seeking.
 */
export function attachVideoFramePrefetch(
  options: AttachVideoFramePrefetchOptions,
): VideoFramePrefetch {
  const { project, compositionId, transport, decodeQueue, assetKindOf } = options;
  const windowSize = options.windowSize ?? 3;

  function warmFrame(frame: number): void {
    if (frame < 0 || frame >= transport.durationInFrames) {
      return;
    }
    const sceneState = resolveSceneAtFrame(project, compositionId, frame);
    for (const { assetRef, frame: localFrame } of findVideoBackedFrames(sceneState, assetKindOf)) {
      // Fire-and-forget: prefetching only ever populates the readiness
      // cache in the background, it must never make the caller wait.
      void decodeQueue.ensureDecoded(assetRef, localFrame).catch(() => {
        // A failed prefetch is not fatal: the frame simply stays not-ready
        // until something (e.g. a later seek) retries decoding it.
      });
    }
  }

  function handleFrameChanged(frame: number): void {
    for (let offset = -windowSize; offset <= windowSize; offset += 1) {
      warmFrame(frame + offset);
    }
  }

  transport.on("frameChanged", handleFrameChanged);
  // Warm the window around the transport's already-current frame immediately,
  // matching how a fresh Transport already renders its initial frame before
  // any play()/seek() call: prefetching should not wait for the first
  // frameChanged to start warming what is already on screen.
  handleFrameChanged(transport.currentFrame);

  function dispose(): void {
    transport.off("frameChanged", handleFrameChanged);
  }

  return { dispose };
}
