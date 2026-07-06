import { describe, expect, it, vi } from "vitest";

import { createDecodeQueue, type DecodeVideoFrameFn } from "./decode-video-frame.js";
import { createVideoReadinessCache } from "./video-readiness.js";

/** One still-unsettled call's pair of settle functions: only one of the two is ever meant to be invoked. */
interface PendingCall {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * A controllable fake decoder: each `decodeVideoFrame` call enqueues one
 * `PendingCall`; `resolve`/`reject` settle the oldest still-pending call for
 * that exact (assetRef, frame) pair (FIFO), so a retried call after a prior
 * one already settled gets its own independent settlement, never the
 * already-used settle function from an earlier, already-settled call.
 */
function createControllableDecoder(): {
  decodeVideoFrame: DecodeVideoFrameFn;
  resolve: (assetRef: string, frame: number) => void;
  reject: (assetRef: string, frame: number, error: Error) => void;
  callCount: (assetRef: string, frame: number) => number;
} {
  const pendingCalls = new Map<string, PendingCall[]>();
  const calls = new Map<string, number>();

  function key(assetRef: string, frame: number): string {
    return `${assetRef}:${frame}`;
  }

  const decodeVideoFrame: DecodeVideoFrameFn = (assetRef, frame) => {
    const k = key(assetRef, frame);
    calls.set(k, (calls.get(k) ?? 0) + 1);
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const list = pendingCalls.get(k) ?? [];
      list.push({ resolve: resolvePromise, reject: rejectPromise });
      pendingCalls.set(k, list);
    });
  };

  return {
    decodeVideoFrame,
    resolve(assetRef, frame) {
      const k = key(assetRef, frame);
      pendingCalls.get(k)?.shift()?.resolve();
    },
    reject(assetRef, frame, error) {
      const k = key(assetRef, frame);
      pendingCalls.get(k)?.shift()?.reject(error);
    },
    callCount(assetRef, frame) {
      return calls.get(key(assetRef, frame)) ?? 0;
    },
  };
}

describe("createDecodeQueue", () => {
  it("resolves immediately without calling the decoder when the pair is already cached ready", async () => {
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 5);
    const decoder = createControllableDecoder();
    const decodeSpy = vi.fn(decoder.decodeVideoFrame);
    const queue = createDecodeQueue(decodeSpy, cache);

    await queue.ensureDecoded("video-asset", 5);

    expect(decodeSpy).not.toHaveBeenCalled();
  });

  it("calls the decoder and marks the cache ready once decoding resolves", async () => {
    const cache = createVideoReadinessCache();
    const decoder = createControllableDecoder();
    const queue = createDecodeQueue(decoder.decodeVideoFrame, cache);

    const pending = queue.ensureDecoded("video-asset", 5);
    expect(cache.isReady("video-asset", 5)).toBe(false);

    decoder.resolve("video-asset", 5);
    await pending;

    expect(cache.isReady("video-asset", 5)).toBe(true);
  });

  it("dedupes two concurrent requests for the same (assetRef, frame): only one decode call", async () => {
    const cache = createVideoReadinessCache();
    const decoder = createControllableDecoder();
    const queue = createDecodeQueue(decoder.decodeVideoFrame, cache);

    const first = queue.ensureDecoded("video-asset", 5);
    const second = queue.ensureDecoded("video-asset", 5);

    expect(decoder.callCount("video-asset", 5)).toBe(1);

    decoder.resolve("video-asset", 5);
    await Promise.all([first, second]);

    expect(cache.isReady("video-asset", 5)).toBe(true);
  });

  it("does not dedupe requests for different frames of the same asset", async () => {
    const cache = createVideoReadinessCache();
    const decoder = createControllableDecoder();
    const queue = createDecodeQueue(decoder.decodeVideoFrame, cache);

    void queue.ensureDecoded("video-asset", 5);
    void queue.ensureDecoded("video-asset", 6);

    expect(decoder.callCount("video-asset", 5)).toBe(1);
    expect(decoder.callCount("video-asset", 6)).toBe(1);
  });

  it("does not mark ready on a rejected decode, and propagates the rejection", async () => {
    const cache = createVideoReadinessCache();
    const decoder = createControllableDecoder();
    const queue = createDecodeQueue(decoder.decodeVideoFrame, cache);
    const failure = new Error("decode failed");

    const pending = queue.ensureDecoded("video-asset", 5);
    decoder.reject("video-asset", 5, failure);

    await expect(pending).rejects.toThrow(failure);
    expect(cache.isReady("video-asset", 5)).toBe(false);
  });

  it("allows a retry (a fresh decoder call) after a prior decode for the same pair rejected", async () => {
    const cache = createVideoReadinessCache();
    const decoder = createControllableDecoder();
    const queue = createDecodeQueue(decoder.decodeVideoFrame, cache);

    const firstAttempt = queue.ensureDecoded("video-asset", 5);
    decoder.reject("video-asset", 5, new Error("first failure"));
    await expect(firstAttempt).rejects.toThrow();

    const secondAttempt = queue.ensureDecoded("video-asset", 5);
    expect(decoder.callCount("video-asset", 5)).toBe(2);

    decoder.resolve("video-asset", 5);
    await secondAttempt;

    expect(cache.isReady("video-asset", 5)).toBe(true);
  });
});
