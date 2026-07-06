import {
  createComposition,
  createFrameContext,
  createProject,
  type FrameContext,
  type Pending,
  type Project,
  type SceneState,
  Sequence,
  Shape,
} from "@cadra/core";
import type { PixelBuffer, PixelReadableRenderer } from "@cadra/renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CompositionNotFoundForRenderError,
  renderComposition,
  type RenderedFrame,
} from "./render-composition.js";

const FPS = 30;
const DURATION_IN_FRAMES = 5;

/** A small project: one composition, one track, one clip spanning the whole timeline. */
function buildProject(overrides: { durationInFrames?: number } = {}): Project {
  const durationInFrames = overrides.durationInFrames ?? DURATION_IN_FRAMES;
  const shape = Shape({ id: "shape-1" });
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames,
    width: 64,
    height: 36,
    tracks: [
      {
        id: "track-1",
        clips: [Sequence({ id: "clip-1", from: 0, durationInFrames, content: shape })],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

/** A single-pixel fully-opaque black `PixelBuffer`, cheap to construct and compare by reference. */
function makePixels(): PixelBuffer {
  return { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) };
}

/**
 * A fake `PixelReadableRenderer`: records every `renderFrame`/`readPixels`
 * call (in call order, interleaved), touches no GPU. `readPixels` resolves
 * with a fresh `PixelBuffer` each call by default, distinguishable by
 * reference across calls unless a fixed `pixels` override is supplied.
 *
 * `renderFrame`/`readPixels` are typed as `ReturnType<typeof vi.fn>` (not
 * plain `PixelReadableRenderer["renderFrame"]`/`["readPixels"]`): widening
 * back to the bare interface method type would lose the mock-specific
 * members (`.mock.calls`, `mockResolvedValueOnce`, ...) tests below need,
 * matching `@cadra/player`'s `transport.test.ts`'s own `createFakeRenderer`.
 */
function createFakePixelReadableRenderer(): Omit<
  PixelReadableRenderer,
  "renderFrame" | "readPixels"
> & {
  renderFrame: ReturnType<typeof vi.fn>;
  readPixels: ReturnType<typeof vi.fn>;
  calls: Array<{ type: "renderFrame" | "readPixels"; sceneState?: SceneState; frameContext?: FrameContext }>;
} {
  const calls: Array<{
    type: "renderFrame" | "readPixels";
    sceneState?: SceneState;
    frameContext?: FrameContext;
  }> = [];

  return {
    calls,
    init: vi.fn().mockResolvedValue(undefined),
    renderFrame: vi.fn((sceneState: SceneState, frameContext: FrameContext) => {
      calls.push({ type: "renderFrame", sceneState, frameContext });
    }),
    resize: vi.fn(),
    dispose: vi.fn(),
    readPixels: vi.fn(async () => {
      calls.push({ type: "readPixels" });
      return makePixels();
    }),
    backend: "webgl2",
    capabilities: { backend: "webgl2", isFallback: true, maxTextureSize: 4096 },
  };
}

/** Drains an async generator into a plain array, for assertions that do not need to inspect intermediate state. */
async function drain<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const value of generator) {
    results.push(value);
  }
  return results;
}

/**
 * `frameContext`'s plain-data fields only, omitting `random`: two
 * separately-constructed `FrameContext`s with identical plain-data fields
 * still have two distinct `random` closures (fresh functions each
 * `createFrameContext` call), so `toEqual`-comparing a raw `FrameContext`
 * across two independent runs always reports a spurious difference even
 * when every actual field, and `random()`'s output, are identical.
 */
function plainFrameContext(frameContext: FrameContext): Omit<FrameContext, "random"> {
  const { frame, fps, time, durationInFrames, seed } = frameContext;
  return { frame, fps, time, durationInFrames, seed };
}

describe("renderComposition: per-frame call order", () => {
  it("calls renderFrame then readPixels exactly once per frame, in order, from 0 to durationInFrames - 1", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    const frames = await drain(
      renderComposition({ project, compositionId: "comp-1", renderer, seed: "det-seed" }),
    );

    expect(frames.map((frame) => frame.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(DURATION_IN_FRAMES);
    expect(renderer.readPixels).toHaveBeenCalledTimes(DURATION_IN_FRAMES);
    // Interleaved in the exact order the spec requires: renderFrame(0),
    // readPixels(0), renderFrame(1), readPixels(1), ... never all five
    // renderFrame calls up front followed by all five readPixels calls.
    expect(renderer.calls.map((call) => call.type)).toEqual([
      "renderFrame",
      "readPixels",
      "renderFrame",
      "readPixels",
      "renderFrame",
      "readPixels",
      "renderFrame",
      "readPixels",
      "renderFrame",
      "readPixels",
    ]);
  });

  it("passes resolveSceneAtFrame's real output as renderFrame's sceneState argument, per frame", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    await drain(renderComposition({ project, compositionId: "comp-1", renderer, seed: "s" }));

    const sceneStates = renderer.calls
      .filter((call) => call.type === "renderFrame")
      .map((call) => call.sceneState);
    expect(sceneStates.map((state) => state?.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(sceneStates.map((state) => state?.layers[0]?.localFrame)).toEqual([0, 1, 2, 3, 4]);
  });

  it("yields each frame's pixels as returned by readPixels", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();
    const distinctPixels = [makePixels(), makePixels(), makePixels(), makePixels(), makePixels()];
    renderer.readPixels
      .mockResolvedValueOnce(distinctPixels[0])
      .mockResolvedValueOnce(distinctPixels[1])
      .mockResolvedValueOnce(distinctPixels[2])
      .mockResolvedValueOnce(distinctPixels[3])
      .mockResolvedValueOnce(distinctPixels[4]);

    const frames = await drain(
      renderComposition({ project, compositionId: "comp-1", renderer, seed: "s" }),
    );

    expect(frames.map((frame) => frame.pixels)).toEqual(distinctPixels);
  });

  it("calls renderer.dispose() exactly once after the last frame completes", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    await drain(renderComposition({ project, compositionId: "comp-1", renderer, seed: "s" }));

    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("throws CompositionNotFoundForRenderError for an unknown compositionId, without touching the renderer", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    await expect(
      drain(renderComposition({ project, compositionId: "does-not-exist", renderer, seed: "s" })),
    ).rejects.toThrow(CompositionNotFoundForRenderError);
    expect(renderer.renderFrame).not.toHaveBeenCalled();
    expect(renderer.readPixels).not.toHaveBeenCalled();
  });

  it("renders zero frames (an immediately-exhausted generator) for a durationInFrames of 0", async () => {
    const project = buildProject({ durationInFrames: 0 });
    const renderer = createFakePixelReadableRenderer();

    const frames = await drain(
      renderComposition({ project, compositionId: "comp-1", renderer, seed: "s" }),
    );

    expect(frames).toEqual([]);
    expect(renderer.renderFrame).not.toHaveBeenCalled();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("renderComposition: determinism", () => {
  it("produces an identical sequence of SceneState/FrameContext arguments to renderFrame across two independent runs with the same project/compositionId/seed", async () => {
    const project = buildProject();
    const rendererA = createFakePixelReadableRenderer();
    const rendererB = createFakePixelReadableRenderer();

    await drain(
      renderComposition({ project, compositionId: "comp-1", renderer: rendererA, seed: "shared-seed" }),
    );
    await drain(
      renderComposition({ project, compositionId: "comp-1", renderer: rendererB, seed: "shared-seed" }),
    );

    const argsA = rendererA.renderFrame.mock.calls;
    const argsB = rendererB.renderFrame.mock.calls;
    const sceneStatesA = argsA.map(([sceneState]) => sceneState);
    const sceneStatesB = argsB.map(([sceneState]) => sceneState);
    expect(sceneStatesA).toEqual(sceneStatesB);

    // FrameContext itself carries a `random` closure (see
    // `plainFrameContext`'s doc for why that specific field cannot be
    // toEqual-compared directly): compare every other field, then verify
    // `random()` behaviorally produces the same sequence too.
    const contextsA = argsA.map(([, frameContext]) => frameContext as FrameContext);
    const contextsB = argsB.map(([, frameContext]) => frameContext as FrameContext);
    expect(contextsA.map(plainFrameContext)).toEqual(contextsB.map(plainFrameContext));
    for (let i = 0; i < contextsA.length; i += 1) {
      expect(contextsA[i]?.random().next()).toBe(contextsB[i]?.random().next());
    }
  });

  it("produces a different FrameContext.seed (and therefore a different random sequence) for a different seed, all else equal", async () => {
    const project = buildProject();
    const rendererA = createFakePixelReadableRenderer();
    const rendererB = createFakePixelReadableRenderer();

    await drain(
      renderComposition({ project, compositionId: "comp-1", renderer: rendererA, seed: "seed-one" }),
    );
    await drain(
      renderComposition({ project, compositionId: "comp-1", renderer: rendererB, seed: "seed-two" }),
    );

    const firstCallContextA = rendererA.renderFrame.mock.calls[0]?.[1] as FrameContext;
    const firstCallContextB = rendererB.renderFrame.mock.calls[0]?.[1] as FrameContext;
    expect(firstCallContextA.random().next()).not.toBe(firstCallContextB.random().next());
  });

  it("never reads the wall clock while walking the loop", async () => {
    const dateNowSpy = vi.spyOn(Date, "now");
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    await drain(renderComposition({ project, compositionId: "comp-1", renderer, seed: "s" }));

    expect(dateNowSpy).not.toHaveBeenCalled();
    dateNowSpy.mockRestore();
  });
});

describe("renderComposition: asset gating", () => {
  /** A `Pending`-shaped fake asset load whose completion is controlled manually by the test. */
  function createControllableAsset(): { pending: Pending; resolve: () => void } {
    let resolve!: () => void;
    const ready = new Promise<void>((res) => {
      resolve = res;
    });
    return { pending: { ready }, resolve };
  }

  it("delays a frame's render until its pending assets resolve, never skipping or reordering", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();
    const frame2Asset = createControllableAsset();

    const results: RenderedFrame[] = [];
    const generatorDone = (async () => {
      for await (const rendered of renderComposition({
        project,
        compositionId: "comp-1",
        renderer,
        seed: "s",
        getPendingAssets: (frame) => (frame === 2 ? [frame2Asset.pending] : []),
      })) {
        results.push(rendered);
      }
    })();

    // Frames 0 and 1 need no assets, so they proceed; frame 2 must not have
    // rendered yet, and nothing past it may have started either.
    await vi.waitFor(() => expect(results.map((r) => r.frame)).toEqual([0, 1]));
    expect(renderer.renderFrame).toHaveBeenCalledTimes(2);

    // Give the pending microtask queue a few turns: still gated.
    await Promise.resolve();
    await Promise.resolve();
    expect(results.map((r) => r.frame)).toEqual([0, 1]);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(2);

    frame2Asset.resolve();
    await generatorDone;

    expect(results.map((r) => r.frame)).toEqual([0, 1, 2, 3, 4]);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(5);
  });

  it("propagates a rejection from a pending asset instead of ever rendering that frame", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();
    const failure = new Error("asset failed to load");

    await expect(
      drain(
        renderComposition({
          project,
          compositionId: "comp-1",
          renderer,
          seed: "s",
          getPendingAssets: (frame) => (frame === 1 ? [{ ready: Promise.reject(failure) }] : []),
        }),
      ),
    ).rejects.toThrow(failure);

    // Frame 0 rendered before the failure; frame 1 (whose asset rejected)
    // and everything after it never did.
    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
  });

  it("defaults to no pending assets (renders immediately) when getPendingAssets is not supplied", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    const frames = await drain(
      renderComposition({ project, compositionId: "comp-1", renderer, seed: "s" }),
    );

    expect(frames).toHaveLength(DURATION_IN_FRAMES);
  });
});

describe("renderComposition: progress callback", () => {
  it("fires once per frame with the correct (frame, totalFrames) values, in order", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();
    const progressCalls: Array<[number, number]> = [];

    await drain(
      renderComposition({
        project,
        compositionId: "comp-1",
        renderer,
        seed: "s",
        onProgress: (frame, totalFrames) => progressCalls.push([frame, totalFrames]),
      }),
    );

    expect(progressCalls).toEqual([
      [0, DURATION_IN_FRAMES],
      [1, DURATION_IN_FRAMES],
      [2, DURATION_IN_FRAMES],
      [3, DURATION_IN_FRAMES],
      [4, DURATION_IN_FRAMES],
    ]);
  });

  it("does not fire at all for a durationInFrames of 0", async () => {
    const project = buildProject({ durationInFrames: 0 });
    const renderer = createFakePixelReadableRenderer();
    const onProgress = vi.fn();

    await drain(
      renderComposition({ project, compositionId: "comp-1", renderer, seed: "s", onProgress }),
    );

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe("renderComposition: cancellation", () => {
  it("stops promptly between frames once the signal aborts, making no further renderFrame/readPixels calls", async () => {
    const project = buildProject({ durationInFrames: 10 });
    const renderer = createFakePixelReadableRenderer();
    const controller = new AbortController();

    const results: RenderedFrame[] = [];
    for await (const rendered of renderComposition({
      project,
      compositionId: "comp-1",
      renderer,
      seed: "s",
      signal: controller.signal,
    })) {
      results.push(rendered);
      if (rendered.frame === 2) {
        controller.abort();
      }
    }

    // Frames 0, 1, 2 were already in flight/yielded by the time abort() was
    // called (aborting happens only after observing frame 2), so the loop
    // stops before frame 3 ever starts.
    expect(results.map((r) => r.frame)).toEqual([0, 1, 2]);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(3);
    expect(renderer.readPixels).toHaveBeenCalledTimes(3);
  });

  it("disposes the renderer exactly once when cancelled mid-render", async () => {
    const project = buildProject({ durationInFrames: 10 });
    const renderer = createFakePixelReadableRenderer();
    const controller = new AbortController();

    for await (const rendered of renderComposition({
      project,
      compositionId: "comp-1",
      renderer,
      seed: "s",
      signal: controller.signal,
    })) {
      if (rendered.frame === 1) {
        controller.abort();
      }
    }

    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("renders no frames at all when the signal is already aborted before iteration starts", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();
    const controller = new AbortController();
    controller.abort();

    const frames = await drain(
      renderComposition({
        project,
        compositionId: "comp-1",
        renderer,
        seed: "s",
        signal: controller.signal,
      }),
    );

    expect(frames).toEqual([]);
    expect(renderer.renderFrame).not.toHaveBeenCalled();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the renderer when the caller stops consuming the generator early (a for-await break), without an explicit abort", async () => {
    const project = buildProject({ durationInFrames: 10 });
    const renderer = createFakePixelReadableRenderer();

    for await (const rendered of renderComposition({
      project,
      compositionId: "comp-1",
      renderer,
      seed: "s",
    })) {
      if (rendered.frame === 1) {
        break;
      }
    }

    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.renderFrame).toHaveBeenCalledTimes(2);
  });
});

describe("renderComposition: PixelReadableRenderer usage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("never calls init() or resize(): the caller owns constructing/initializing the renderer", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    await drain(renderComposition({ project, compositionId: "comp-1", renderer, seed: "s" }));

    expect(renderer.init).not.toHaveBeenCalled();
    expect(renderer.resize).not.toHaveBeenCalled();
  });

  it("passes the exact FrameContext createFrameContext would construct for each frame (fps/durationInFrames/seed all threaded through)", async () => {
    const project = buildProject();
    const renderer = createFakePixelReadableRenderer();

    await drain(renderComposition({ project, compositionId: "comp-1", renderer, seed: "my-seed" }));

    const expected = createFrameContext({
      frame: 2,
      fps: FPS,
      durationInFrames: DURATION_IN_FRAMES,
      seed: "my-seed",
    });
    const actual = renderer.calls.filter((call) => call.type === "renderFrame")[2]?.frameContext;
    // plainFrameContext (not toEqual on the raw FrameContext): see its own
    // doc, `random` is a fresh closure every createFrameContext call.
    expect(actual && plainFrameContext(actual)).toEqual(plainFrameContext(expected));
    expect(actual?.random().next()).toBe(expected.random().next());
  });
});
