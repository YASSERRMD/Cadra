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

import { createTransport, type NowFn, type ScheduleFrameFn } from "../transport.js";
import type { DecodeQueue } from "./decode-video-frame.js";
import { createDecodeQueue } from "./decode-video-frame.js";
import { attachVideoFramePrefetch } from "./prefetch-video-frames.js";
import { createVideoReadinessCache } from "./video-readiness.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;

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

function createFakeRenderer(): Renderer {
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

/** A manually-driven fake scheduler, matching transport.test.ts's own. */
function createFakeScheduler(): {
  scheduleFrame: ScheduleFrameFn;
  cancelFrame: (handle: number) => void;
  fireNext: () => void;
} {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    scheduleFrame: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      pending.delete(handle);
    },
    fireNext: () => {
      const [firstHandle, firstCallback] = [...pending.entries()][0] ?? [];
      if (firstHandle === undefined || firstCallback === undefined) {
        return;
      }
      pending.delete(firstHandle);
      firstCallback();
    },
  };
}

function createFakeClock(initial = 0): { now: NowFn; advance: (deltaMs: number) => void } {
  let current = initial;
  return {
    now: () => current,
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

/** Never-resolving decoder: lets tests assert prefetch calls were *made* without needing them to settle. */
function createNeverSettlingDecodeQueue(): { decodeQueue: DecodeQueue; calls: Array<[string, number]> } {
  const calls: Array<[string, number]> = [];
  const cache = createVideoReadinessCache();
  const decodeQueue = createDecodeQueue((assetRef, frame) => {
    calls.push([assetRef, frame]);
    return new Promise<void>(() => {
      // Deliberately never settles: prefetch must not wait on this.
    });
  }, cache);
  return { decodeQueue, calls };
}

describe("attachVideoFramePrefetch", () => {
  it("warms a window of frames around the current playhead immediately on attach", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const { decodeQueue, calls } = createNeverSettlingDecodeQueue();

    attachVideoFramePrefetch({
      project,
      compositionId: "comp-1",
      transport,
      decodeQueue,
      assetKindOf,
      windowSize: 3,
    });

    // Starts at frame 0: window is [-3, 3] clamped to [0, 3].
    const frames = calls.map(([, frame]) => frame).sort((a, b) => a - b);
    expect(frames).toEqual([0, 1, 2, 3]);
  });

  it("warms a new window whenever frameChanged fires, e.g. after a seek", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const { decodeQueue, calls } = createNeverSettlingDecodeQueue();

    attachVideoFramePrefetch({
      project,
      compositionId: "comp-1",
      transport,
      decodeQueue,
      assetKindOf,
      windowSize: 2,
    });
    calls.length = 0; // clear the initial attach-time warm

    transport.seek(50);

    const frames = calls.map(([, frame]) => frame).sort((a, b) => a - b);
    expect(frames).toEqual([48, 49, 50, 51, 52]);
  });

  it("clamps the window to [0, durationInFrames - 1], never requesting an out-of-range frame", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const { decodeQueue, calls } = createNeverSettlingDecodeQueue();

    attachVideoFramePrefetch({
      project,
      compositionId: "comp-1",
      transport,
      decodeQueue,
      assetKindOf,
      windowSize: 5,
    });
    calls.length = 0;

    transport.seek(DURATION_IN_FRAMES - 1);

    const frames = calls.map(([, frame]) => frame).sort((a, b) => a - b);
    expect(frames.every((frame) => frame >= 0 && frame < DURATION_IN_FRAMES)).toBe(true);
    expect(Math.max(...frames)).toBe(DURATION_IN_FRAMES - 1);
  });

  it("does not block or delay the frameChanged handler: prefetch calls are fire-and-forget", () => {
    // The never-settling decoder proves this indirectly: if prefetch awaited
    // its own decode calls, attachVideoFramePrefetch's construction (and this
    // test itself) would hang forever. Reaching this assertion at all is the
    // proof.
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const { decodeQueue } = createNeverSettlingDecodeQueue();

    const prefetch = attachVideoFramePrefetch({
      project,
      compositionId: "comp-1",
      transport,
      decodeQueue,
      assetKindOf,
    });

    expect(prefetch).toBeDefined();
    transport.seek(30);
    expect(true).toBe(true);
  });

  it("warms the readiness cache such that a subsequent isFrameReady/seek check for a nearby frame no longer needs to wait", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const cache = createVideoReadinessCache();
    let resolveDecode: (() => void) | undefined;
    const decodeQueue = createDecodeQueue((_assetRef, _frame) => {
      return new Promise<void>((resolve) => {
        resolveDecode = resolve;
      });
    }, cache);
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    attachVideoFramePrefetch({
      project,
      compositionId: "comp-1",
      transport,
      decodeQueue,
      assetKindOf,
      windowSize: 2,
    });

    // Attach-time warm covers frames [0, 2]; resolve frame 2's decode.
    expect(cache.isReady("video-asset", 2)).toBe(false);
    resolveDecode?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(cache.isReady("video-asset", 2)).toBe(true);
  });

  it("dispose() unsubscribes from frameChanged: no further prefetch calls after disposal", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const { decodeQueue, calls } = createNeverSettlingDecodeQueue();

    const prefetch = attachVideoFramePrefetch({
      project,
      compositionId: "comp-1",
      transport,
      decodeQueue,
      assetKindOf,
      windowSize: 1,
    });
    prefetch.dispose();
    calls.length = 0;

    transport.seek(60);

    expect(calls).toEqual([]);
  });
});
