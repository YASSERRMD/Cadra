import type { Project } from "@cadra/core";
import { resolveSceneAtFrame } from "@cadra/core";

import type { Transport } from "../transport.js";
import type { DecodeQueue } from "./decode-video-frame.js";
import type { AssetKindOfFn, VideoBackedFrame, VideoReadinessCache } from "./video-readiness.js";
import { findVideoBackedFrames, isSceneStateVideoReady } from "./video-readiness.js";

/** Options accepted by `attachFrameAccurateSeeking`. */
export interface AttachFrameAccurateSeekingOptions {
  /** The project whose composition's video-backed content readiness gates seeking. */
  project: Project;
  /** Which of `project`'s compositions to check readiness against. */
  compositionId: string;
  /**
   * The readiness cache to gate/populate on seek. Must be the exact same
   * cache backing whatever `IsFrameReadyFn` was passed as `Transport`'s
   * `isFrameReady` construction option (see this module's own doc for why).
   */
  cache: VideoReadinessCache;
  /** Resolves an `assetRef` to its `AssetKind`. */
  assetKindOf: AssetKindOfFn;
  /** Where a not-yet-ready seek target's video content gets decoded, populating `cache` on success. */
  decodeQueue: DecodeQueue;
}

/** Events `FrameAccurateSeeking` emits for its own seek-gating buffering signal (see this module's own doc for why this is a separate stream from `Transport`'s `buffering`). */
export interface FrameAccurateSeekingEventMap {
  buffering: boolean;
}

/** Imperative handle returned by `attachFrameAccurateSeeking`. */
export interface FrameAccurateSeeking {
  /**
   * Subscribes `handler` to `event`. Currently only `"buffering"`, fired
   * `true` when a `seek()` call is waiting on video-content readiness and
   * `false` once the (still-latest) seek that triggered it completes.
   */
  on(event: "buffering", handler: (value: boolean) => void): void;
  /** Unsubscribes `handler` from `event`. */
  off(event: "buffering", handler: (value: boolean) => void): void;
  /** Restores `transport`'s original `seek`. Idempotent. */
  dispose(): void;
}

/**
 * Wraps `transport.seek` so seeking itself gates on video-content readiness,
 * fixing the "stale frame" bug `Transport.seek()` has on its own today: it
 * renders unconditionally, with no readiness check at all, so seeking onto a
 * frame whose video texture has not finished decoding immediately shows a
 * frame composited from stale video content next to the new frame's
 * everything-else.
 *
 * Follows the exact save-by-reference/reassign/restore-on-dispose technique
 * `attachAudioToTransport` (Phase 16) already established for extending
 * `Transport` externally, rather than modifying `transport.ts` itself: see
 * that module's own doc for why saving by reference (not re-binding) is
 * correct, since `Transport`'s methods are already closures, not
 * `this`-bound.
 *
 * ## Reconciling `isFrameReady` (constructor option) with wrapping `seek` (a mutable method)
 *
 * `Transport.isFrameReady` is only accepted at construction time; unlike
 * `seek`, there is no mutable method to wrap post-construction, and
 * `Transport`'s own internal event emission (the `Set` `on`/`off` add to) is
 * a private closure this module has no reference to and, per the "wrap, do
 * not modify transport.ts" constraint, must not reach into. So the two
 * integration points reconcile like this instead of one wrapping the other:
 *
 * 1. The caller builds one shared `VideoReadinessCache` up front (see
 *    `createVideoReadinessCache`).
 * 2. That cache backs an `IsFrameReadyFn` (`createVideoFrameReadyCheck`)
 *    passed as `Transport`'s `isFrameReady` option at construction time,
 *    activating Phase 13's tick-loop buffering path (and its existing
 *    `buffering` event) for stalls encountered during ordinary playback
 *    advancement.
 * 3. This function is called afterward with that *same* cache, so its
 *    wrapped `seek` gates on and populates the identical readiness state:
 *    the two integration points can never disagree about what is ready,
 *    because they read one cache, not two independently-tracked ones.
 *
 * Because this module cannot push onto `Transport`'s own private
 * `buffering` event stream (only `Transport`'s internals can, from inside
 * `tick()`, which never runs for a paused seek), the buffering signal a
 * caller of `seek()` observes here is `FrameAccurateSeeking`'s own
 * `"buffering"` event, not `Transport`'s. `Transport.buffering` remains
 * exclusively the tick-loop/playback-stall signal it already was; this
 * module's `"buffering"` is specifically "a seek() call is currently gated
 * on readiness". A host wanting one unified spinner condition subscribes to
 * both and ORs them together.
 *
 * ## Seek coalescing
 *
 * Only the most recently requested seek ever actually completes. A
 * monotonically increasing generation counter is captured at the start of
 * each wrapped `seek(frame)` call; when that call's readiness wait resolves,
 * it proceeds (calling through to the original `seek`, rendering, flipping
 * this module's `buffering` back to `false`) only if its captured
 * generation is still the latest one issued. A superseded call's eventual
 * resolution is silently discarded: no call to the original `seek`, no
 * render, no `frameChanged`, no `buffering(false)` on its behalf. This is
 * exactly why `Transport.currentFrame` only ever reflects the frame actually
 * rendered, never the most recently requested one: a discarded seek never
 * touches `currentFrame` at all, since it never calls through to the
 * original `seek`.
 */
export function attachFrameAccurateSeeking(
  transport: Transport,
  options: AttachFrameAccurateSeekingOptions,
): FrameAccurateSeeking {
  const { project, compositionId, cache, assetKindOf, decodeQueue } = options;

  const handlers = new Set<(value: boolean) => void>();
  function emitBuffering(value: boolean): void {
    for (const handler of handlers) {
      handler(value);
    }
  }

  // Saved by reference, not re-bound: see attachAudioToTransport's own doc
  // for why (Transport's methods are already closures over its internal
  // state, not `this`-bound), so dispose() can restore it byte-for-byte.
  const originalSeek = transport.seek;

  // Bumped on every wrappedSeek() call; a pending decode only proceeds if
  // its own captured generation is still this value once it resolves. This
  // is the entire coalescing mechanism: seek(A) then seek(B) before A
  // resolves bumps latestGeneration past A's captured value, so A's
  // resolution finds itself stale and discards.
  let latestGeneration = 0;
  let isBuffering = false;
  let isDisposed = false;

  function setBuffering(value: boolean): void {
    if (isBuffering === value) {
      return;
    }
    isBuffering = value;
    emitBuffering(value);
  }

  /** Every video-backed `(assetRef, frame)` pair in `sceneState` not yet ready per `cache`. */
  function collectNotReady(sceneState: ReturnType<typeof resolveSceneAtFrame>): VideoBackedFrame[] {
    return findVideoBackedFrames(sceneState, assetKindOf).filter(
      ({ assetRef, frame }) => !cache.isReady(assetRef, frame),
    );
  }

  function wrappedSeek(frame: number): void {
    if (isDisposed) {
      return;
    }
    latestGeneration += 1;
    const generation = latestGeneration;

    const sceneState = resolveSceneAtFrame(project, compositionId, frame);
    if (isSceneStateVideoReady(sceneState, cache, assetKindOf)) {
      // Already cached: render immediately, no buffering flicker. This is
      // the common case the prefetch window (attachVideoFramePrefetch)
      // exists to make the usual path through this function.
      originalSeek(frame);
      return;
    }

    setBuffering(true);
    const notReady = collectNotReady(sceneState);

    Promise.all(
      notReady.map(({ assetRef, frame: localFrame }) =>
        decodeQueue.ensureDecoded(assetRef, localFrame),
      ),
    )
      .then(() => {
        if (isDisposed || generation !== latestGeneration) {
          // Superseded by a later seek() call (or disposed) while decoding
          // was in flight: discard entirely, per this function's
          // coalescing contract. Only the still-latest call's own
          // resolution (or an already-ready synchronous path above) ever
          // renders and flips buffering back off.
          return;
        }
        originalSeek(frame);
        setBuffering(false);
      })
      .catch(() => {
        // A failed decode should not leave this stuck buffering forever;
        // only the still-latest call gets to clear it, matching the
        // success path's own generation guard.
        if (isDisposed || generation !== latestGeneration) {
          return;
        }
        setBuffering(false);
      });
  }

  transport.seek = wrappedSeek;

  function dispose(): void {
    if (isDisposed) {
      return;
    }
    isDisposed = true;
    transport.seek = originalSeek;
    handlers.clear();
  }

  return {
    on(_event, handler) {
      handlers.add(handler);
    },
    off(_event, handler) {
      handlers.delete(handler);
    },
    dispose,
  };
}
