// @vitest-environment jsdom
import {
  createComposition,
  createProject,
  type FrameContext,
  type Project,
  type SceneState,
  Sequence,
  Shape,
} from "@cadra/core";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "@cadra/renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NowFn, ScheduleFrameFn } from "../transport.js";
import { mountPreview, type PreviewHandle } from "./mount-preview.js";
import type { ObservedSize, ObserveResizeFn, UnobserveResizeFn } from "./resize-observation.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;
const COMPOSITION_WIDTH = 640;
const COMPOSITION_HEIGHT = 360;

/** A small project: one composition, one track, one clip spanning the whole timeline. */
function buildProject(): Project {
  const shape = Shape({ id: "shape-1" });
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: COMPOSITION_WIDTH,
    height: COMPOSITION_HEIGHT,
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

/**
 * A fake `Renderer`, same shape as `three-renderer.test.ts`'s fakes: records
 * calls, touches no GPU. `init` resolves asynchronously (a microtask), same
 * as a real WebGPU renderer's would, so tests that need to observe
 * mountPreview's pre-ready queuing behavior can do so before awaiting it.
 */
function createFakeRenderer(): Renderer & {
  init: ReturnType<typeof vi.fn>;
  renderFrame: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
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

/** A manually-driven fake scheduler, same shape as transport.test.ts's. */
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

/** A fake `now()`, same shape as transport.test.ts's. */
function createFakeClock(initial = 0): { now: NowFn; advance: (deltaMs: number) => void } {
  let current = initial;
  return {
    now: () => current,
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

/**
 * A fake `ObserveResizeFn`: records the callback it was given and exposes
 * `fireResize` to invoke it manually with synthetic dimensions, since real
 * `ResizeObserver` is unavailable in jsdom and, even where available,
 * requires a real layout engine to ever fire.
 */
function createFakeResizeObserver(): {
  observeResize: ObserveResizeFn;
  fireResize: (size: ObservedSize) => void;
  unobserveCallCount: () => number;
} {
  let onResize: ((size: ObservedSize) => void) | undefined;
  let unobserveCalls = 0;
  const observeResize: ObserveResizeFn = (_element, callback): UnobserveResizeFn => {
    onResize = callback;
    return () => {
      unobserveCalls += 1;
    };
  };
  return {
    observeResize,
    fireResize: (size) => onResize?.(size),
    unobserveCallCount: () => unobserveCalls,
  };
}

/** Waits for any pending microtasks (e.g. a fake renderer's resolved init() promise) to flush. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("mountPreview: DOM construction", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("attaches a canvas element inside the container", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();

    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });

    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
  });

  it("gives the container a tabindex so it can receive keyboard focus", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();

    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });

    expect(container.getAttribute("tabindex")).toBe("0");
  });

  it("does not overwrite an existing tabindex the host already set", () => {
    container.setAttribute("tabindex", "3");
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();

    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });

    expect(container.getAttribute("tabindex")).toBe("3");
  });

  it("calls renderer.init with the canvas element", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();

    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });

    expect(renderer.init).toHaveBeenCalledTimes(1);
    const [target] = renderer.init.mock.calls[0] as [RenderTarget, RenderSize];
    expect(target).toBe(container.querySelector("canvas"));
  });

  it("throws a clear error for an unknown compositionId", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();

    expect(() =>
      mountPreview(container, {
        project,
        compositionId: "does-not-exist",
        renderer,
        observeResize,
      }),
    ).toThrow(/does-not-exist/);
  });
});

describe("mountPreview: scrubber pointer interaction", () => {
  let container: HTMLElement;
  let handle: PreviewHandle;
  let renderer: ReturnType<typeof createFakeRenderer>;
  let scrubberTrack: HTMLElement;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const project = buildProject();
    renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    handle = mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });
    await flushMicrotasks();

    scrubberTrack = container.querySelector('[role="slider"]') as HTMLElement;
    // jsdom implements no layout engine: getBoundingClientRect always
    // returns zeros. Stubbing it with a synthetic track rect is exactly the
    // seam the pure pointerPositionToFrame function exists to make possible
    // to test around.
    vi.spyOn(scrubberTrack, "getBoundingClientRect").mockReturnValue({
      left: 100,
      right: 300,
      width: 200,
      top: 0,
      bottom: 20,
      height: 20,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    container.remove();
  });

  it("mousedown at the track's left edge seeks to frame 0", () => {
    scrubberTrack.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(0);
  });

  it("mousedown at the track's right edge seeks to the last frame", () => {
    scrubberTrack.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 300, bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(DURATION_IN_FRAMES - 1);
  });

  it("mousedown at the track's midpoint seeks to the midpoint frame", () => {
    scrubberTrack.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 200, bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(45); // (90 - 1) / 2 = 44.5, rounds to 45
  });

  it("dragging (mousemove after mousedown) continues seeking to the new pointer position", () => {
    scrubberTrack.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(0);

    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 300, bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(DURATION_IN_FRAMES - 1);
  });

  it("mousemove without a preceding mousedown does not seek", () => {
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 300, bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(0);
  });

  it("mousemove after mouseup no longer seeks (drag has ended)", () => {
    scrubberTrack.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 100, bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));

    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 300, bubbles: true, cancelable: true }),
    );

    expect(handle.getFrame()).toBe(0);
  });

  it("clamps a mousedown position outside the track to the nearest end", () => {
    scrubberTrack.dispatchEvent(
      new MouseEvent("mousedown", { clientX: 5000, bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(DURATION_IN_FRAMES - 1);
  });
});

describe("mountPreview: step back/forward controls", () => {
  let container: HTMLElement;
  let handle: PreviewHandle;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    handle = mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });
    await flushMicrotasks();
    handle.seek(10);
  });

  afterEach(() => {
    container.remove();
  });

  it("the step-forward button moves exactly one frame forward", () => {
    const stepForward = container.querySelector(".cadra-preview__step-forward") as HTMLButtonElement;
    stepForward.click();
    expect(handle.getFrame()).toBe(11);
  });

  it("the step-back button moves exactly one frame back", () => {
    const stepBack = container.querySelector(".cadra-preview__step-back") as HTMLButtonElement;
    stepBack.click();
    expect(handle.getFrame()).toBe(9);
  });

  it("clicking step-forward repeatedly advances one frame per click", () => {
    const stepForward = container.querySelector(".cadra-preview__step-forward") as HTMLButtonElement;
    stepForward.click();
    stepForward.click();
    stepForward.click();
    expect(handle.getFrame()).toBe(13);
  });
});

describe("mountPreview: keyboard shortcuts", () => {
  let container: HTMLElement;
  let handle: PreviewHandle;
  let renderer: ReturnType<typeof createFakeRenderer>;
  let clock: ReturnType<typeof createFakeClock>;
  let scheduler: ReturnType<typeof createFakeScheduler>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const project = buildProject();
    renderer = createFakeRenderer();
    clock = createFakeClock(0);
    scheduler = createFakeScheduler();
    const { observeResize } = createFakeResizeObserver();
    handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    await flushMicrotasks();
    handle.seek(10);
  });

  afterEach(() => {
    container.remove();
  });

  it("Space toggles play/pause on the focused container", () => {
    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }),
    );
    expect(scheduler.pendingCount()).toBe(1); // play() scheduled a tick

    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "Space", bubbles: true, cancelable: true }),
    );
    expect(scheduler.pendingCount()).toBe(0); // pause() canceled it
  });

  it("ArrowLeft steps exactly one frame back", () => {
    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ArrowLeft", bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(9);
  });

  it("ArrowRight steps exactly one frame forward", () => {
    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(11);
  });

  it("repeated ArrowRight presses step one frame each", () => {
    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true, cancelable: true }),
    );
    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(12);
  });

  it("does not toggle play/pause or step for an unrelated key", () => {
    container.dispatchEvent(
      new KeyboardEvent("keydown", { code: "KeyA", bubbles: true, cancelable: true }),
    );
    expect(handle.getFrame()).toBe(10);
    expect(scheduler.pendingCount()).toBe(0);
  });
});

describe("mountPreview: play/pause button", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("reflects isPlaying state in its label immediately on click, not only after frameChanged", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const scheduler = createFakeScheduler();
    const clock = createFakeClock(0);
    const { observeResize } = createFakeResizeObserver();
    mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    await flushMicrotasks();

    const playPauseButton = container.querySelector(
      ".cadra-preview__play-pause",
    ) as HTMLButtonElement;
    expect(playPauseButton.textContent).toBe("Play");

    playPauseButton.click();
    expect(playPauseButton.textContent).toBe("Pause");

    playPauseButton.click();
    expect(playPauseButton.textContent).toBe("Play");
  });

  it("switches back to Play once playback ends naturally", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const scheduler = createFakeScheduler();
    const clock = createFakeClock(0);
    const { observeResize } = createFakeResizeObserver();
    mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    await flushMicrotasks();

    const playPauseButton = container.querySelector(
      ".cadra-preview__play-pause",
    ) as HTMLButtonElement;
    playPauseButton.click();
    expect(playPauseButton.textContent).toBe("Pause");

    clock.advance(100000); // far past the end
    scheduler.fireNext();

    expect(playPauseButton.textContent).toBe("Play");
  });
});

describe("mountPreview: frame/fps readout", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the initial frame and fps immediately once ready", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });
    await flushMicrotasks();

    const frameReadout = container.querySelector(".cadra-preview__frame-readout");
    const fpsReadout = container.querySelector(".cadra-preview__fps-readout");
    expect(frameReadout?.textContent).toBe(`0 / ${DURATION_IN_FRAMES}`);
    expect(fpsReadout?.textContent).toBe(`${FPS} fps`);
  });

  it("updates the frame readout as the transport seeks", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.seek(42);

    const frameReadout = container.querySelector(".cadra-preview__frame-readout");
    expect(frameReadout?.textContent).toBe(`42 / ${DURATION_IN_FRAMES}`);
  });
});

describe("mountPreview: responsive resizing preserves aspect ratio", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("resizes the canvas and calls renderer.resize with a letterboxed size for a wider container", async () => {
    const project = buildProject(); // composition is 640x360 (16:9)
    const renderer = createFakeRenderer();
    const { observeResize, fireResize } = createFakeResizeObserver();
    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });
    await flushMicrotasks();
    renderer.resize.mockClear();

    // Container is much wider than 16:9 (e.g. 2000x400, ratio 5): height
    // binds, width pillarboxes down from 2000.
    fireResize({ width: 2000, height: 400 });

    expect(renderer.resize).toHaveBeenCalledTimes(1);
    const [size] = renderer.resize.mock.calls[0] as [RenderSize];
    expect(size.height).toBe(400);
    // 400 * (640/360) = 711.11 -> rounds to 711.
    expect(size.width).toBe(711);

    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvas.width).toBe(711);
    expect(canvas.height).toBe(400);
  });

  it("resizes the canvas and calls renderer.resize with a pillarboxed size for a narrower container", async () => {
    const project = buildProject(); // composition is 640x360 (16:9)
    const renderer = createFakeRenderer();
    const { observeResize, fireResize } = createFakeResizeObserver();
    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });
    await flushMicrotasks();
    renderer.resize.mockClear();

    // Container is narrower than 16:9 (e.g. 400x800): width binds, height
    // letterboxes down from 800.
    fireResize({ width: 400, height: 800 });

    expect(renderer.resize).toHaveBeenCalledTimes(1);
    const [size] = renderer.resize.mock.calls[0] as [RenderSize];
    expect(size.width).toBe(400);
    // 400 / (640/360) = 225.
    expect(size.height).toBe(225);
  });

  it("does not call renderer.resize again for an unchanged computed size", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize, fireResize } = createFakeResizeObserver();
    mountPreview(container, { project, compositionId: "comp-1", renderer, observeResize });
    await flushMicrotasks();

    fireResize({ width: 1280, height: 720 }); // exact 16:9 match
    renderer.resize.mockClear();

    fireResize({ width: 1280, height: 720 }); // identical size again

    expect(renderer.resize).not.toHaveBeenCalled();
  });
});

describe("mountPreview: pre-ready action queuing", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("getFrame() reports 0 before renderer.init() resolves", () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();

    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });

    expect(handle.getFrame()).toBe(0);
  });

  it("a seek() called before renderer.init() resolves is applied once it does", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();

    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    handle.seek(30);
    expect(handle.getFrame()).toBe(30); // queued value reported immediately

    await flushMicrotasks();

    expect(handle.getFrame()).toBe(30); // now backed by the real Transport
    expect(renderer.renderFrame).toHaveBeenCalled();
    const lastCall = renderer.renderFrame.mock.calls.at(-1) as [SceneState, FrameContext];
    expect(lastCall[0].frame).toBe(30);
  });

  it("a play() called before renderer.init() resolves starts playback once ready", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const scheduler = createFakeScheduler();
    const { observeResize } = createFakeResizeObserver();

    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    handle.play();

    await flushMicrotasks();

    expect(scheduler.pendingCount()).toBe(1);
  });
});

describe("mountPreview: dispose", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("removes the canvas and control elements from the container", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.dispose();

    expect(container.querySelector("canvas")).toBeNull();
    expect(container.children.length).toBe(0);
  });

  it("disposes the underlying renderer", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.dispose();

    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });

  it("stops observing container resize", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize, unobserveCallCount } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.dispose();

    expect(unobserveCallCount()).toBe(1);
  });

  it("removes the tabindex it added to the container", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.dispose();

    expect(container.hasAttribute("tabindex")).toBe(false);
  });

  it("no further rendering happens after dispose, even if a queued action resolves late", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });

    handle.dispose(); // dispose while renderer.init() is still in flight
    await flushMicrotasks();

    // The queued construction inside mountPreview must have bailed out
    // rather than constructing a Transport (which renders immediately) or
    // calling any further renderer method past dispose.
    expect(renderer.renderFrame).not.toHaveBeenCalled();
  });

  it("is idempotent: calling dispose() a second time does not throw", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.dispose();

    expect(() => handle.dispose()).not.toThrow();
  });

  it("calling seek()/play()/pause()/getFrame() after dispose() does not throw", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.dispose();

    expect(() => handle.seek(10)).not.toThrow();
    expect(() => handle.play()).not.toThrow();
    expect(() => handle.pause()).not.toThrow();
    expect(() => handle.getFrame()).not.toThrow();
  });

  it("seek() after dispose() does not trigger any further render", async () => {
    const project = buildProject();
    const renderer = createFakeRenderer();
    const { observeResize } = createFakeResizeObserver();
    const handle = mountPreview(container, {
      project,
      compositionId: "comp-1",
      renderer,
      observeResize,
    });
    await flushMicrotasks();

    handle.dispose();
    renderer.renderFrame.mockClear();
    handle.seek(50);

    expect(renderer.renderFrame).not.toHaveBeenCalled();
  });
});
