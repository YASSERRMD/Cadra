import type { VideoReadinessCache } from "./video-readiness.js";

/**
 * Decodes (or otherwise makes available) the exact frame `sampleVideoFrame`
 * would need for `assetRef` at `frame`, resolving once that content is
 * usable. Real implementations wrap `@cadra/renderer`'s
 * `sampleVideoFrame`/`loadVideo` (already frame-index-driven, see that
 * module's own doc); tests inject a fake with controllable resolution
 * timing, since real video decoding does not exist headlessly.
 *
 * Idempotent in spirit: calling this again for an `(assetRef, frame)` pair
 * already resolved is expected to resolve promptly (e.g. because the
 * underlying sampler/loader itself caches), not to force a redundant decode.
 * This module does not enforce that itself, see `createDecodeQueue` for the
 * de-duplication layer that does.
 */
export type DecodeVideoFrameFn = (assetRef: string, frame: number) => Promise<void>;

/**
 * Wraps a raw `DecodeVideoFrameFn` with in-flight de-duplication and
 * cache-population: two callers requesting the same `(assetRef, frame)`
 * while the first decode is still pending share one underlying call, and
 * every successful decode marks `cache` ready before resolving, so both the
 * readiness checker (decision 1) and any caller awaiting this queue observe
 * the same, single source of truth.
 *
 * A rejected decode is not cached as ready (so a later call retries rather
 * than being permanently stuck "not ready"), and is removed from the
 * in-flight map so that retry is possible; the rejection itself still
 * propagates to every caller currently awaiting that same in-flight decode.
 */
export interface DecodeQueue {
  /** Ensures `assetRef`'s `frame` is decoded and marked ready, deduping concurrent requests for the same pair. */
  ensureDecoded(assetRef: string, frame: number): Promise<void>;
}

function inFlightKey(assetRef: string, frame: number): string {
  return `${assetRef}:${frame}`;
}

/** Creates a `DecodeQueue` wrapping `decodeVideoFrame`, populating `cache` on success. */
export function createDecodeQueue(
  decodeVideoFrame: DecodeVideoFrameFn,
  cache: VideoReadinessCache,
): DecodeQueue {
  const inFlight = new Map<string, Promise<void>>();

  function ensureDecoded(assetRef: string, frame: number): Promise<void> {
    if (cache.isReady(assetRef, frame)) {
      return Promise.resolve();
    }

    const key = inFlightKey(assetRef, frame);
    const existing = inFlight.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const pending = decodeVideoFrame(assetRef, frame)
      .then(() => {
        cache.markReady(assetRef, frame);
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, pending);
    return pending;
  }

  return { ensureDecoded };
}
