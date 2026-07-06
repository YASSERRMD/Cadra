import {
  type AssetKind,
  createComposition,
  createProject,
  type FrameContext,
  Image,
  type Project,
  type SceneState,
  Sequence,
} from "@cadra/core";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "@cadra/renderer";
import { describe, expect, it, vi } from "vitest";

import { createTransport, type Transport } from "../transport.js";
import { attachFrameAccurateSeeking } from "./attach-frame-accurate-seeking.js";
import { createVideoFrameReadyCheck } from "./create-video-frame-ready-check.js";
import type { DecodeQueue, DecodeVideoFrameFn } from "./decode-video-frame.js";
import { createDecodeQueue } from "./decode-video-frame.js";
import { attachVideoFramePrefetch } from "./prefetch-video-frames.js";
import { createVideoReadinessCache, type VideoReadinessCache } from "./video-readiness.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;

/**
 * Flushes pending microtasks by yielding to a macrotask boundary, so
 * assertions after resolving a fake decode are not sensitive to exactly how
 * many internal `await`/`.then()` hops the readiness/coalescing chain
 * happens to use (matching `@cadra/core`'s own `wait-for-assets.test.ts`
 * helper of the same name/shape).
 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function assetKindOf(assetRef: string): AssetKind | undefined {
  return assetRef === "video-asset" ? "video" : undefined;
}

function buildProject(): Project {
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: 640,
    height: 360,
    tracks: [
      {
        id: "track-1",
        clips: [
          Sequence({
            id: "clip-1",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: Image({ id: "video-node", assetRef: "video-asset" }),
          }),
        ],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

function createFakeRenderer(): Renderer & { renderFrame: ReturnType<typeof vi.fn> } {
  return {
    init: vi.fn(async (_target: RenderTarget, _size: RenderSize) => undefined),
    renderFrame: vi.fn((_sceneState: SceneState, _frameContext: FrameContext) => undefined),
    resize: vi.fn((_size: RenderSize) => undefined),
    dispose: vi.fn(() => undefined),
    backend: "webgl2",
    capabilities: {
      backend: "webgl2",
      isFallback: true,
      maxTextureSize: 4096,
    } as RendererCapabilities,
  };
}

/** One still-unsettled decode call's pair of settle functions. */
interface PendingCall {
  resolve: () => void;
  reject: (error: Error) => void;
}

/**
 * A controllable fake video decoder: `decodeVideoFrame` never resolves on
 * its own, `resolveFrame`/`rejectFrame` settle the oldest pending call for
 * an exact (assetRef, frame) pair. This is the "manually-resolved promise"
 * seam the phase's environment constraint calls for, standing in for real
 * `HTMLVideoElement`/`requestVideoFrameCallback` decoding, neither of which
 * exists headlessly.
 */
function createControllableVideoDecoder(): {
  decodeVideoFrame: DecodeVideoFrameFn;
  resolveFrame: (assetRef: string, frame: number) => void;
  rejectFrame: (assetRef: string, frame: number, error: Error) => void;
  callsFor: (assetRef: string, frame: number) => number;
} {
  const pendingCalls = new Map<string, PendingCall[]>();
  const calls = new Map<string, number>();

  function key(assetRef: string, frame: number): string {
    return `${assetRef}:${frame}`;
  }

  const decodeVideoFrame: DecodeVideoFrameFn = (assetRef, frame) => {
    const k = key(assetRef, frame);
    calls.set(k, (calls.get(k) ?? 0) + 1);
    return new Promise<void>((resolve, reject) => {
      const list = pendingCalls.get(k) ?? [];
      list.push({ resolve, reject });
      pendingCalls.set(k, list);
    });
  };

  return {
    decodeVideoFrame,
    resolveFrame(assetRef, frame) {
      pendingCalls.get(key(assetRef, frame))?.shift()?.resolve();
    },
    rejectFrame(assetRef, frame, error) {
      pendingCalls.get(key(assetRef, frame))?.shift()?.reject(error);
    },
    callsFor(assetRef, frame) {
      return calls.get(key(assetRef, frame)) ?? 0;
    },
  };
}

/** Builds a `Transport` plus a shared `VideoReadinessCache`/decode-queue rig wired the way this module's own doc prescribes. */
function buildRig(overrides?: { cache?: VideoReadinessCache }): {
  project: Project;
  transport: Transport;
  renderer: ReturnType<typeof createFakeRenderer>;
  cache: VideoReadinessCache;
  decoder: ReturnType<typeof createControllableVideoDecoder>;
  decodeQueue: DecodeQueue;
} {
  const project = buildProject();
  const renderer = createFakeRenderer();
  const cache = overrides?.cache ?? createVideoReadinessCache();
  const decoder = createControllableVideoDecoder();
  const decodeQueue = createDecodeQueue(decoder.decodeVideoFrame, cache);
  const isFrameReady = createVideoFrameReadyCheck({
    project,
    compositionId: "comp-1",
    cache,
    assetKindOf,
  });
  const transport = createTransport({
    project,
    compositionId: "comp-1",
    renderer,
    isFrameReady,
  });
  return { project, transport, renderer, cache, decoder, decodeQueue };
}

describe("attachFrameAccurateSeeking: already-cached frame", () => {
  it("renders immediately with no buffering when the target frame's video content is already cached", () => {
    const { project, transport, renderer, cache, decodeQueue } = buildRig();
    cache.markReady("video-asset", 40);
    renderer.renderFrame.mockClear();

    const bufferingEvents: boolean[] = [];
    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });
    seeking.on("buffering", (value) => bufferingEvents.push(value));

    transport.seek(40);

    expect(transport.currentFrame).toBe(40);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(bufferingEvents).toEqual([]);
  });
});

describe("attachFrameAccurateSeeking: not-yet-cached frame", () => {
  it("emits buffering(true), holds currentFrame, then buffering(false) and renders once decoding resolves", async () => {
    const { project, transport, renderer, cache, decoder, decodeQueue } = buildRig();
    renderer.renderFrame.mockClear();

    const bufferingEvents: boolean[] = [];
    const frameChangedEvents: number[] = [];
    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });
    seeking.on("buffering", (value) => bufferingEvents.push(value));
    transport.on("frameChanged", (frame) => frameChangedEvents.push(frame));

    transport.seek(40);

    // Not ready yet: currentFrame must not have moved, nothing rendered,
    // buffering(true) fired.
    expect(transport.currentFrame).toBe(0);
    expect(renderer.renderFrame).not.toHaveBeenCalled();
    expect(bufferingEvents).toEqual([true]);
    expect(frameChangedEvents).toEqual([]);

    decoder.resolveFrame("video-asset", 40);
    // Flush the microtask queue: Promise.all -> .then chain.
    await flushMicrotasks();

    expect(transport.currentFrame).toBe(40);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(bufferingEvents).toEqual([true, false]);
    expect(frameChangedEvents).toEqual([40]);
    expect(cache.isReady("video-asset", 40)).toBe(true);
  });

  it("renders the frame-index-exact content: the localFrame checked/decoded matches what the clip's own frame-local math computes, not a drifted real-time value", async () => {
    // Clip starts at frame 10, so seeking to global frame 45 must gate
    // on/decode localFrame 35, exactly matching resolveSequenceFrame's own
    // math, never global frame 45 itself and never anything derived from
    // wall-clock time.
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "track-1",
          clips: [
            Sequence({
              id: "clip-1",
              from: 10,
              durationInFrames: DURATION_IN_FRAMES - 10,
              content: Image({ id: "video-node", assetRef: "video-asset" }),
            }),
          ],
        },
      ],
    });
    const project = createProject({ id: "p1", name: "Project", compositions: [composition] });
    const renderer = createFakeRenderer();
    const cache = createVideoReadinessCache();
    const decoder = createControllableVideoDecoder();
    const decodeQueue = createDecodeQueue(decoder.decodeVideoFrame, cache);
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });
    const transport = createTransport({ project, compositionId: "comp-1", renderer, isFrameReady });
    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });
    void seeking;

    transport.seek(45);

    expect(decoder.callsFor("video-asset", 35)).toBe(1);
    expect(decoder.callsFor("video-asset", 45)).toBe(0);

    decoder.resolveFrame("video-asset", 35);
    await flushMicrotasks();

    expect(transport.currentFrame).toBe(45);
    expect(cache.isReady("video-asset", 35)).toBe(true);
  });
});

describe("attachFrameAccurateSeeking: rapid re-seek coalescing", () => {
  it("discards a superseded seek entirely: resolving A after B was requested renders nothing for A", async () => {
    const { project, transport, renderer, cache, decoder, decodeQueue } = buildRig();
    renderer.renderFrame.mockClear();

    const frameChangedEvents: number[] = [];
    const bufferingEvents: boolean[] = [];
    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });
    transport.on("frameChanged", (frame) => frameChangedEvents.push(frame));
    seeking.on("buffering", (value) => bufferingEvents.push(value));

    transport.seek(20); // A
    transport.seek(60); // B, before A's decode resolves

    expect(transport.currentFrame).toBe(0);
    expect(renderer.renderFrame).not.toHaveBeenCalled();

    // Resolve A's decode first: per the coalescing contract, this must be a
    // complete no-op (no render, no frameChanged, no buffering(false)).
    decoder.resolveFrame("video-asset", 20);
    await flushMicrotasks();

    expect(transport.currentFrame).toBe(0);
    expect(renderer.renderFrame).not.toHaveBeenCalled();
    expect(frameChangedEvents).toEqual([]);
    expect(bufferingEvents).toEqual([true]); // still buffering: only true so far, A's resolution did not flip it

    // Now resolve B's decode: this is the one that should actually complete.
    decoder.resolveFrame("video-asset", 60);
    await flushMicrotasks();

    expect(transport.currentFrame).toBe(60);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(frameChangedEvents).toEqual([60]);
    expect(bufferingEvents).toEqual([true, false]);
  });

  it("converges on exactly the final target through many rapid intermediate seeks, never flickering through them", async () => {
    const { project, transport, renderer, cache, decoder, decodeQueue } = buildRig();
    renderer.renderFrame.mockClear();
    const frameChangedEvents: number[] = [];
    transport.on("frameChanged", (frame) => frameChangedEvents.push(frame));

    attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });

    // Scrub rapidly through several frames, none of which resolve until the
    // very end.
    for (const target of [10, 15, 22, 33, 47, 58, 70]) {
      transport.seek(target);
    }

    // Resolve every one of them, in arbitrary order (a real decoder offers
    // no ordering guarantee either): only the last-requested (70) may win.
    for (const target of [10, 15, 22, 33, 47, 58, 70]) {
      decoder.resolveFrame("video-asset", target);
    }
    await flushMicrotasks();

    expect(transport.currentFrame).toBe(70);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(frameChangedEvents).toEqual([70]);
  });

  it("a seek to an already-ready frame issued after a pending not-ready seek also supersedes it", async () => {
    const { project, transport, renderer, cache, decoder, decodeQueue } = buildRig();
    cache.markReady("video-asset", 60);
    renderer.renderFrame.mockClear();
    const frameChangedEvents: number[] = [];
    transport.on("frameChanged", (frame) => frameChangedEvents.push(frame));

    attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });

    transport.seek(20); // not ready, will hang
    transport.seek(60); // already ready: renders synchronously right away

    expect(transport.currentFrame).toBe(60);
    expect(frameChangedEvents).toEqual([60]);

    decoder.resolveFrame("video-asset", 20);
    await flushMicrotasks();

    // The now-resolved seek(20) must still not have done anything.
    expect(transport.currentFrame).toBe(60);
    expect(frameChangedEvents).toEqual([60]);
  });
});

describe("attachFrameAccurateSeeking: prefetch integration", () => {
  it("a seek within an already-prefetched window resolves without needing to wait", () => {
    const { project, transport, renderer, cache, decodeQueue } = buildRig();

    attachVideoFramePrefetch({
      project,
      compositionId: "comp-1",
      transport,
      decodeQueue,
      assetKindOf,
      windowSize: 5,
    });
    // Simulate the prefetch's decode having already completed for frame 3
    // (a real sampler would resolve asynchronously; this test only needs to
    // confirm the seek path itself does not wait once the cache is warm).
    cache.markReady("video-asset", 3);
    renderer.renderFrame.mockClear();

    const bufferingEvents: boolean[] = [];
    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });
    seeking.on("buffering", (value) => bufferingEvents.push(value));

    transport.seek(3);

    expect(transport.currentFrame).toBe(3);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(bufferingEvents).toEqual([]);
  });
});

describe("attachFrameAccurateSeeking: dispose", () => {
  it("restores the original seek, un-gating readiness entirely", () => {
    const { project, transport, renderer, cache, decodeQueue } = buildRig();
    renderer.renderFrame.mockClear();
    const originalSeek = transport.seek;

    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });
    expect(transport.seek).not.toBe(originalSeek);

    seeking.dispose();

    expect(transport.seek).toBe(originalSeek);

    // Video content still not cached, but seek is back to unconditional.
    transport.seek(40);
    expect(transport.currentFrame).toBe(40);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
  });

  it("is idempotent", () => {
    const { project, transport, cache, decodeQueue } = buildRig();
    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });

    expect(() => {
      seeking.dispose();
      seeking.dispose();
    }).not.toThrow();
  });

  it("a pending seek's resolution after dispose() does nothing", async () => {
    const { project, transport, renderer, cache, decoder, decodeQueue } = buildRig();
    renderer.renderFrame.mockClear();

    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });

    transport.seek(40);
    seeking.dispose();

    decoder.resolveFrame("video-asset", 40);
    await flushMicrotasks();

    expect(transport.currentFrame).toBe(0);
    expect(renderer.renderFrame).not.toHaveBeenCalled();
  });
});
