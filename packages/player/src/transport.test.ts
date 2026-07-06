import {
  createComposition,
  createProject,
  type FrameContext,
  type Project,
  resolveSceneAtFrame,
  type SceneState,
  Sequence,
  Shape,
} from "@cadra/core";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "@cadra/renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CompositionNotFoundForTransportError,
  createTransport,
  type NowFn,
  type ScheduleFrameFn,
  type Transport,
} from "./transport.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;

/** A small project: one composition, one track, one clip spanning the whole timeline. */
function buildProject(): Project {
  const shape = Shape({ id: "shape-1" });
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
          Sequence({ id: "clip-1", from: 0, durationInFrames: DURATION_IN_FRAMES, content: shape }),
        ],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

/** A fake `Renderer`: records every renderFrame call's arguments, touches no GPU. */
function createFakeRenderer(): Renderer & {
  renderFrame: ReturnType<typeof vi.fn>;
} {
  return {
    init: vi.fn(async (_target: RenderTarget, _size: RenderSize) => undefined),
    renderFrame: vi.fn((_sceneState: SceneState, _frameContext: FrameContext) => undefined),
    resize: vi.fn((_size: RenderSize) => undefined),
    dispose: vi.fn(() => undefined),
    backend: "webgl2",
    capabilities: { backend: "webgl2", isFallback: true, maxTextureSize: 4096 } as
      RendererCapabilities,
  };
}

/**
 * A manually-driven fake scheduler: `scheduleFrame` records the callback
 * instead of using a real timer or rAF, and `fireNext` invokes exactly one
 * pending callback. Lets tests fire an arbitrary number of ticks at
 * arbitrary injected `now()` values, independent of any real clock.
 */
function createFakeScheduler(): {
  scheduleFrame: ScheduleFrameFn;
  cancelFrame: (handle: number) => void;
  fireNext: () => void;
  pendingCount: () => number;
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
    pendingCount: () => pending.size,
  };
}

/** A fake `now()`: starts at `initial`, settable directly so tests control elapsed time exactly. */
function createFakeClock(initial = 0): { now: NowFn; set: (value: number) => void; advance: (deltaMs: number) => void } {
  let current = initial;
  return {
    now: () => current,
    set: (value: number) => {
      current = value;
    },
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

describe("createTransport: construction", () => {
  it("throws CompositionNotFoundForTransportError for an unknown compositionId", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    expect(() =>
      createTransport({ project, compositionId: "does-not-exist", renderer }),
    ).toThrow(CompositionNotFoundForTransportError);
  });

  it("exposes fps and durationInFrames read from the composition", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });

    expect(transport.fps).toBe(FPS);
    expect(transport.durationInFrames).toBe(DURATION_IN_FRAMES);
  });

  it("renders frame 0 immediately at construction, before play() is ever called", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    createTransport({ project, compositionId: "comp-1", renderer });

    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    const [sceneState, frameContext] = renderer.renderFrame.mock.calls[0] as [
      SceneState,
      FrameContext,
    ];
    expect(sceneState.frame).toBe(0);
    expect(frameContext.frame).toBe(0);
  });

  it("starts paused (isPlaying false) and at currentFrame 0", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });

    expect(transport.isPlaying).toBe(false);
    expect(transport.currentFrame).toBe(0);
  });
});

describe("createTransport: frame-advancement formula, decoupled from tick cadence", () => {
  let project: Project;
  let renderer: ReturnType<typeof createFakeRenderer>;
  let clock: ReturnType<typeof createFakeClock>;
  let scheduler: ReturnType<typeof createFakeScheduler>;
  let transport: Transport;

  beforeEach(() => {
    project = buildProject();
    renderer = createFakeRenderer();
    clock = createFakeClock(0);
    scheduler = createFakeScheduler();
    transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
  });

  it("computes frame as startFrame + floor(elapsedSeconds * fps * playbackRate)", () => {
    transport.play();
    // 1 second elapsed at 30fps, rate 1 -> floor(1 * 30 * 1) = 30.
    clock.advance(1000);
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(30);
  });

  it("lands on the exact same final frame whether driven by many small ticks or few large ones", () => {
    // Scenario A: 10 small ticks of 100ms each (1000ms total).
    transport.play();
    for (let i = 0; i < 10; i += 1) {
      clock.advance(100);
      scheduler.fireNext();
    }
    const frameAfterManyTicks = transport.currentFrame;

    // Scenario B: fresh transport, 2 large ticks of 500ms each (1000ms total).
    const renderer2 = createFakeRenderer();
    const clock2 = createFakeClock(0);
    const scheduler2 = createFakeScheduler();
    const transport2 = createTransport({
      project,
      compositionId: "comp-1",
      renderer: renderer2,
      now: clock2.now,
      scheduleFrame: scheduler2.scheduleFrame,
      cancelFrame: scheduler2.cancelFrame,
    });
    transport2.play();
    clock2.advance(500);
    scheduler2.fireNext();
    clock2.advance(500);
    scheduler2.fireNext();
    const frameAfterFewTicks = transport2.currentFrame;

    expect(frameAfterManyTicks).toBe(30);
    expect(frameAfterFewTicks).toBe(30);
    expect(frameAfterManyTicks).toBe(frameAfterFewTicks);
  });

  it("lands exactly on a frame boundary even when repeated floating-point subtraction of now() values would otherwise round it one frame short", () => {
    // A real accumulation of 1000/30ms-sized deltas from a nonzero anchor
    // hits IEEE-754 subtraction noise (now() - anchorNow lands a few ULPs
    // under the exact frame boundary): this must still resolve to the frame
    // that has, for all real purposes, actually been reached, not the one
    // before it.
    transport.play();
    clock.advance(300); // 9 frames, exactly
    scheduler.fireNext();
    expect(transport.currentFrame).toBe(9);

    clock.advance(1000 / FPS); // one more frame's worth of time, from a nonzero anchor
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(10);
  });

  it("firing many extra ticks with zero additional elapsed time never advances the frame further", () => {
    transport.play();
    clock.advance(500);
    scheduler.fireNext();
    const frameAfterFirstTick = transport.currentFrame;

    for (let i = 0; i < 20; i += 1) {
      scheduler.fireNext();
    }

    expect(transport.currentFrame).toBe(frameAfterFirstTick);
  });

  it("does not emit frameChanged on a tick whose computed frame is unchanged from the previous one", () => {
    const frameChangedHandler = vi.fn();
    transport.on("frameChanged", frameChangedHandler);

    transport.play();
    clock.advance(1000 / FPS / 2); // half a frame's worth of time: still frame 0
    scheduler.fireNext();

    expect(frameChangedHandler).not.toHaveBeenCalled();
  });
});

describe("createTransport: play/pause/seek", () => {
  let project: Project;
  let renderer: ReturnType<typeof createFakeRenderer>;
  let clock: ReturnType<typeof createFakeClock>;
  let scheduler: ReturnType<typeof createFakeScheduler>;
  let transport: Transport;

  beforeEach(() => {
    project = buildProject();
    renderer = createFakeRenderer();
    clock = createFakeClock(0);
    scheduler = createFakeScheduler();
    transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
  });

  it("play() sets isPlaying true and schedules a tick", () => {
    transport.play();
    expect(transport.isPlaying).toBe(true);
    expect(scheduler.pendingCount()).toBe(1);
  });

  it("pause() sets isPlaying false and cancels the scheduled tick", () => {
    transport.play();
    transport.pause();
    expect(transport.isPlaying).toBe(false);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("pause() freezes the current frame; further clock advancement has no effect until play() again", () => {
    transport.play();
    clock.advance(500);
    scheduler.fireNext();
    const frameAtPause = transport.currentFrame;

    transport.pause();
    clock.advance(10000);

    expect(transport.currentFrame).toBe(frameAtPause);
  });

  it("resuming play() after pause() continues advancing from the paused frame, not from frame 0", () => {
    transport.play();
    clock.advance(500); // 15 frames at 30fps
    scheduler.fireNext();
    expect(transport.currentFrame).toBe(15);

    transport.pause();
    clock.advance(2000); // time passes while paused; must not count

    transport.play();
    clock.advance(500); // another 15 frames from the resume point
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(30);
  });

  it("seek() jumps directly to the requested frame and renders it", () => {
    transport.seek(45);
    expect(transport.currentFrame).toBe(45);
    const lastCall = renderer.renderFrame.mock.calls.at(-1) as [SceneState, FrameContext];
    expect(lastCall[0].frame).toBe(45);
    expect(lastCall[1].frame).toBe(45);
  });

  it("seek() clamps to durationInFrames - 1 when given a frame past the end", () => {
    transport.seek(9999);
    expect(transport.currentFrame).toBe(DURATION_IN_FRAMES - 1);
  });

  it("seek() clamps to 0 when given a negative frame", () => {
    transport.seek(-50);
    expect(transport.currentFrame).toBe(0);
  });

  it("seek() while playing re-anchors the clock so subsequent advancement is relative to the new frame", () => {
    transport.play();
    clock.advance(300); // 9 frames
    scheduler.fireNext();

    transport.seek(50);
    clock.advance(1000 / FPS); // exactly 1 frame's worth of time after the seek

    scheduler.fireNext();
    expect(transport.currentFrame).toBe(51);
  });

  it("seeking to the exact frame already current still triggers a render (but not a duplicate frameChanged)", () => {
    const frameChangedHandler = vi.fn();
    transport.on("frameChanged", frameChangedHandler);
    renderer.renderFrame.mockClear();

    transport.seek(0); // already at frame 0

    expect(renderer.renderFrame).toHaveBeenCalledTimes(1);
    expect(frameChangedHandler).not.toHaveBeenCalled();
  });
});

describe("createTransport: loop behavior", () => {
  function makeShortLoopTransport(loop: boolean) {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      loop,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    return { transport, renderer, clock, scheduler };
  }

  it("without loop, clamps at durationInFrames - 1 and stops advancing", () => {
    const { transport, clock, scheduler } = makeShortLoopTransport(false);
    transport.play();
    clock.advance(10000); // far past the end
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(DURATION_IN_FRAMES - 1);
    expect(transport.isPlaying).toBe(false);
  });

  it("without loop, emits ended exactly once when playback reaches the end", () => {
    const { transport, clock, scheduler } = makeShortLoopTransport(false);
    const endedHandler = vi.fn();
    transport.on("ended", endedHandler);

    transport.play();
    clock.advance(10000);
    scheduler.fireNext();

    expect(endedHandler).toHaveBeenCalledTimes(1);
  });

  it("with loop enabled, wraps back around rather than stopping", () => {
    const { transport, clock, scheduler } = makeShortLoopTransport(true);
    const endedHandler = vi.fn();
    transport.on("ended", endedHandler);

    transport.play();
    // durationInFrames = 90 at 30fps = 3 seconds per loop; advance 3.5s -> 0.5s into the second loop = frame 15.
    clock.advance(3500);
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(15);
    expect(transport.isPlaying).toBe(true);
    expect(endedHandler).not.toHaveBeenCalled();
  });

  it("loop can be toggled after construction via the loop property", () => {
    const { transport, clock, scheduler } = makeShortLoopTransport(false);
    expect(transport.loop).toBe(false);
    transport.loop = true;
    expect(transport.loop).toBe(true);

    transport.play();
    clock.advance(3500);
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(15);
    expect(transport.isPlaying).toBe(true);
  });

  it("play() after a non-looped natural end restarts from frame 0", () => {
    const { transport, clock, scheduler } = makeShortLoopTransport(false);
    transport.play();
    clock.advance(10000);
    scheduler.fireNext();
    expect(transport.isPlaying).toBe(false);

    transport.play();
    expect(transport.currentFrame).toBe(0);
    expect(transport.isPlaying).toBe(true);
  });
});

describe("createTransport: frameChanged events", () => {
  it("emits frameChanged with the new frame number whenever the resolved frame changes", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const frames: number[] = [];
    transport.on("frameChanged", (frame) => frames.push(frame));

    transport.play();
    clock.advance(1000 / FPS); // exactly 1 frame
    scheduler.fireNext();
    clock.advance(1000 / FPS); // exactly 1 more frame
    scheduler.fireNext();

    expect(frames).toEqual([1, 2]);
  });

  it("off() unsubscribes a handler so it stops receiving further events", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const handler = vi.fn();
    transport.on("frameChanged", handler);
    transport.off("frameChanged", handler);

    transport.play();
    clock.advance(1000);
    scheduler.fireNext();

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("createTransport: buffering", () => {
  it("emits buffering(true) and holds the current frame when isFrameReady reports not-ready", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const ready = false;
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
      isFrameReady: () => ready,
    });
    const bufferingEvents: boolean[] = [];
    transport.on("buffering", (value) => bufferingEvents.push(value));

    transport.play();
    clock.advance(1000); // would normally advance to frame 30, but never ready
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(0);
    expect(bufferingEvents).toEqual([true]);
  });

  it("does not re-emit buffering(true) on every subsequent still-not-ready tick", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
      isFrameReady: () => false,
    });
    const bufferingEvents: boolean[] = [];
    transport.on("buffering", (value) => bufferingEvents.push(value));

    transport.play();
    clock.advance(500);
    scheduler.fireNext();
    clock.advance(500);
    scheduler.fireNext();
    clock.advance(500);
    scheduler.fireNext();

    expect(bufferingEvents).toEqual([true]);
  });

  it("resumes advancing and emits buffering(false) once isFrameReady reports ready again", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    let ready = false;
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
      isFrameReady: () => ready,
    });
    const bufferingEvents: boolean[] = [];
    transport.on("buffering", (value) => bufferingEvents.push(value));

    transport.play();
    clock.advance(1000);
    scheduler.fireNext(); // not ready: holds frame 0, buffering(true)
    expect(transport.currentFrame).toBe(0);

    ready = true;
    clock.advance(1000 / FPS); // exactly 1 frame's worth, from the re-anchored point
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(1);
    expect(bufferingEvents).toEqual([true, false]);
  });

  it("time spent buffering does not count toward frame advancement once playback resumes", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    let ready = false;
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
      isFrameReady: () => ready,
    });

    transport.play();
    // A long stretch of "not ready" ticks: real time passes, but none of it
    // should ever be reflected in the frame count once we resume.
    for (let i = 0; i < 5; i += 1) {
      clock.advance(2000);
      scheduler.fireNext();
    }
    expect(transport.currentFrame).toBe(0);

    ready = true;
    clock.advance(1000 / FPS); // exactly 1 frame from the resume point, not from play() originally
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(1);
  });

  it("defaults to always-ready when isFrameReady is not supplied", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const bufferingEvents: boolean[] = [];
    transport.on("buffering", (value) => bufferingEvents.push(value));

    transport.play();
    clock.advance(1000);
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(30);
    expect(bufferingEvents).toEqual([]);
  });
});

describe("createTransport: playback rate", () => {
  it("setPlaybackRate changes how fast the frame number advances", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    transport.setPlaybackRate(2);
    transport.play();
    clock.advance(500); // 0.5s at rate 2 -> 1s worth of frames -> 30 frames
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(30);
  });

  it("a playback rate change mid-play only affects advancement from that point forward", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    transport.play();
    clock.advance(1000); // rate 1: 30 frames
    scheduler.fireNext();
    expect(transport.currentFrame).toBe(30);

    transport.setPlaybackRate(0.5);
    clock.advance(1000); // rate 0.5: 15 more frames
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(45);
  });

  it("settles and announces whatever frame elapsed time had already reached at the moment of the rate change, even before the next tick fires", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const frameChangedHandler = vi.fn();
    transport.on("frameChanged", frameChangedHandler);

    transport.play();
    // Time elapses, but no tick has fired yet to observe it.
    clock.advance(500); // 15 frames' worth, at the still-current rate 1
    transport.setPlaybackRate(2);

    // currentFrame reflects the settled frame immediately, and a render/
    // frameChanged already happened for it, rather than silently deferring
    // until the next tick.
    expect(transport.currentFrame).toBe(15);
    expect(frameChangedHandler).toHaveBeenCalledWith(15);
    const lastCall = renderer.renderFrame.mock.calls.at(-1) as [SceneState, FrameContext];
    expect(lastCall[0].frame).toBe(15);
  });

  it("changing playback rate does not alter what a given resolved frame contains: same frame number, same SceneState", () => {
    const project = buildProject();
    const rendererA = createFakeRenderer();
    const rendererB = createFakeRenderer();
    const clockA = createFakeClock(0);
    const clockB = createFakeClock(0);
    const schedulerA = createFakeScheduler();
    const schedulerB = createFakeScheduler();

    const transportRate1 = createTransport({
      project,
      compositionId: "comp-1",
      renderer: rendererA,
      now: clockA.now,
      scheduleFrame: schedulerA.scheduleFrame,
      cancelFrame: schedulerA.cancelFrame,
      playbackRate: 1,
    });
    const transportRate3 = createTransport({
      project,
      compositionId: "comp-1",
      renderer: rendererB,
      now: clockB.now,
      scheduleFrame: schedulerB.scheduleFrame,
      cancelFrame: schedulerB.cancelFrame,
      playbackRate: 3,
    });

    // Drive both to frame 20 via seek (direct, rate-independent) and compare
    // the exact SceneState each renderer received.
    transportRate1.seek(20);
    transportRate3.seek(20);

    const sceneStateAtRate1 = rendererA.renderFrame.mock.calls.at(-1)?.[0] as SceneState;
    const sceneStateAtRate3 = rendererB.renderFrame.mock.calls.at(-1)?.[0] as SceneState;

    expect(sceneStateAtRate1).toEqual(sceneStateAtRate3);
    expect(sceneStateAtRate1.frame).toBe(20);
    expect(sceneStateAtRate3.frame).toBe(20);
  });
});

describe("createTransport: dispose", () => {
  it("cancels an in-flight scheduled tick, same as pause()", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    transport.play();
    expect(scheduler.pendingCount()).toBe(1);

    transport.dispose();

    expect(scheduler.pendingCount()).toBe(0);
    expect(transport.isPlaying).toBe(false);
  });

  it("is idempotent: calling dispose() a second time does not throw", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });

    transport.dispose();

    expect(() => transport.dispose()).not.toThrow();
  });

  it("play() after dispose() is a no-op: isPlaying stays false and no tick is scheduled", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    transport.dispose();
    transport.play();

    expect(transport.isPlaying).toBe(false);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("seek() after dispose() is a no-op: currentFrame is unchanged and no additional render happens", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    transport.seek(10);
    const frameBeforeDispose = transport.currentFrame;

    transport.dispose();
    renderer.renderFrame.mockClear();
    transport.seek(50);

    expect(transport.currentFrame).toBe(frameBeforeDispose);
    expect(renderer.renderFrame).not.toHaveBeenCalled();
  });

  it("setPlaybackRate() after dispose() is a no-op", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    transport.dispose();

    expect(() => transport.setPlaybackRate(2)).not.toThrow();
  });

  it("on()/off() after dispose() do not throw, and no further events fire", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const handler = vi.fn();

    transport.dispose();

    expect(() => transport.on("frameChanged", handler)).not.toThrow();
    expect(() => transport.off("frameChanged", handler)).not.toThrow();
    transport.seek(20); // would emit frameChanged if not disposed
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispose() while playing stops further frame advancement even if the clock keeps advancing", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    transport.play();
    clock.advance(500);
    scheduler.fireNext();
    const frameAtDispose = transport.currentFrame;

    transport.dispose();
    clock.advance(10000);

    expect(transport.currentFrame).toBe(frameAtDispose);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("createTransport: cross-check against resolveSceneAtFrame", () => {
  it("seeking to frame N passes the renderer the exact same SceneState resolveSceneAtFrame(project, compositionId, N) produces directly", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });

    transport.seek(42);

    const expected = resolveSceneAtFrame(project, "comp-1", 42);
    const lastCall = renderer.renderFrame.mock.calls.at(-1) as [SceneState, FrameContext];
    // resolveSceneAtFrame memoizes per (Project reference, compositionId,
    // frame): calling it again here with the same project reference and the
    // same frame returns the exact same cached object the transport itself
    // must have received from its own internal call, so this is a strict
    // reference-equality check, not just deep equality.
    expect(lastCall[0]).toBe(expected);
  });

  it("the same cross-check holds while driving playback via play()/tick, not just seek()", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });

    transport.play();
    clock.advance(1000); // 30 frames
    scheduler.fireNext();

    const expected = resolveSceneAtFrame(project, "comp-1", 30);
    const lastCall = renderer.renderFrame.mock.calls.at(-1) as [SceneState, FrameContext];
    expect(lastCall[0]).toBe(expected);
  });
});
