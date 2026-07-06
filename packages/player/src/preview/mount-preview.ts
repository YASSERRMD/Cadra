import type { Project } from "@cadra/core";
import type { Renderer } from "@cadra/renderer";

import type {
  CancelFrameFn,
  IsFrameReadyFn,
  NowFn,
  ScheduleFrameFn,
  Transport,
} from "../transport.js";
import { createTransport } from "../transport.js";
import { computeAspectFitSize } from "./aspect-fit.js";
import type { ObserveResizeFn, UnobserveResizeFn } from "./resize-observation.js";
import { observeResizeWithResizeObserver } from "./resize-observation.js";
import { pointerPositionToFrame } from "./scrubber-math.js";

/** Options accepted by `mountPreview`. */
export interface MountPreviewOptions {
  /** The project to preview. */
  project: Project;
  /** Which of `project`'s compositions to preview. */
  compositionId: string;
  /** Renderer to draw each resolved frame into. Must not already be `init`-ed; `mountPreview` owns its lifecycle. */
  renderer: Renderer;
  /** Whether playback wraps back to frame 0 at the end instead of stopping. Defaults to `false`. */
  loop?: boolean;
  /** Initial playback rate; 1 is real-time. Defaults to `1`. */
  playbackRate?: number;
  /** Seed for the underlying `Transport`'s `FrameContext`. Defaults to `Transport`'s own default. */
  seed?: string | number;
  /** Wall-clock time source, forwarded to the underlying `Transport`. Defaults to `performance.now`. */
  now?: NowFn;
  /** Tick scheduler, forwarded to the underlying `Transport`. Defaults to `requestAnimationFrame`. */
  scheduleFrame?: ScheduleFrameFn;
  /** Cancels a tick scheduled by `scheduleFrame`, forwarded to the underlying `Transport`. */
  cancelFrame?: CancelFrameFn;
  /** Per-frame asset-readiness check, forwarded to the underlying `Transport`. Defaults to always-ready. */
  isFrameReady?: IsFrameReadyFn;
  /**
   * Observes `container`'s size, invoking `renderer.resize` (via the
   * aspect-fit computation) whenever it changes. Defaults to a real
   * `ResizeObserver`. Overridable in tests, since real `ResizeObserver`
   * requires a layout engine no DOM test environment reliably implements.
   */
  observeResize?: ObserveResizeFn;
}

/** Imperative handle returned by `mountPreview`. */
export interface PreviewHandle {
  /** Jumps directly to `frame`, same clamping as `Transport.seek`. */
  seek(frame: number): void;
  /** Starts (or resumes) playback. */
  play(): void;
  /** Pauses playback. */
  pause(): void;
  /** The frame currently resolved and rendered. */
  getFrame(): number;
  /**
   * Tears down everything `mountPreview` created: the canvas element, the
   * transport UI, the keydown listener, resize observation, and the
   * underlying `Transport` (via `Transport.dispose()`) and `Renderer` (via
   * `Renderer.dispose()`).
   *
   * Idempotent, and every other `PreviewHandle` method is a no-op afterward
   * (never throws), matching `Transport.dispose()`'s own choice: a host's
   * unmount cleanup should not need to guard trailing calls.
   */
  dispose(): void;
}

/** Formats `frame` (0-indexed) out of `durationInFrames` as e.g. "12 / 90". */
function formatFrameReadout(frame: number, durationInFrames: number): string {
  return `${frame} / ${durationInFrames}`;
}

/** Formats `fps` as e.g. "30 fps", trimming a trailing ".00" for whole frame rates. */
function formatFpsReadout(fps: number): string {
  const rounded = Math.round(fps * 100) / 100;
  return `${rounded} fps`;
}

/**
 * Mounts a framework-agnostic preview surface (canvas, play/pause, step
 * back/forward, scrubber, frame/fps readout) into `container`.
 *
 * Sequence: attaches a `<canvas>` and control bar into `container`,
 * `renderer.init()`s against that canvas, then (once init resolves)
 * constructs a `Transport` over `project`/`compositionId` and wires up the
 * UI/keyboard shortcuts. `renderer.init()` is asynchronous (WebGPU's common
 * case), so calls to the returned `PreviewHandle`'s `seek`/`play`/`pause`
 * made before it resolves are queued (last one per kind wins) and replayed,
 * in order, immediately once the `Transport` exists; `getFrame()` reports
 * the pending seek target (or `0`) until then.
 *
 * `container` receives a `tabindex` (if it does not already have a
 * non-negative one) so it can hold keyboard focus, and a `keydown` listener
 * is attached directly to `container`, not `window`: `Space` toggles
 * play/pause, `ArrowLeft`/`ArrowRight` step one frame back/forward. Scoping
 * to `container` means a host page's other keyboard input is never
 * hijacked.
 *
 * Responsive sizing: `container`'s size is observed (via `observeResize`,
 * defaulting to a real `ResizeObserver`) and the canvas is resized to the
 * largest size that fits within the container while exactly preserving the
 * composition's aspect ratio (letterbox/pillarbox, never stretch), via
 * `computeAspectFitSize`.
 */
export function mountPreview(container: HTMLElement, options: MountPreviewOptions): PreviewHandle {
  const composition = options.project.compositions.find(
    (candidate) => candidate.id === options.compositionId,
  );
  if (composition === undefined) {
    // Transport itself validates this too (and throws the same shape of
    // error), but mountPreview needs width/height before Transport ever
    // gets constructed, so it validates up front rather than surfacing a
    // confusing failure from deep inside canvas/UI construction.
    throw new Error(
      `mountPreview: no composition with id "${options.compositionId}" in the given project.`,
    );
  }
  const { width: compositionWidth, height: compositionHeight, durationInFrames, fps } = composition;

  const observeResize = options.observeResize ?? observeResizeWithResizeObserver;

  let isDisposed = false;
  let transport: Transport | undefined;
  // Queued intents applied once the Transport exists, replayed in the order
  // received. A seek queued after a play (or vice versa) both survive; only
  // repeated seeks collapse to the last one, matching how a user rapidly
  // dragging a scrubber before the renderer is ready only cares about where
  // they finally let go.
  const pendingActions: Array<
    { kind: "seek"; frame: number } | { kind: "play" } | { kind: "pause" }
  > = [];
  let pendingFrameForGetFrame = 0;

  // --- DOM construction ---

  const root = document.createElement("div");
  root.className = "cadra-preview";

  const canvas = document.createElement("canvas");
  canvas.className = "cadra-preview__canvas";
  root.appendChild(canvas);

  const controls = document.createElement("div");
  controls.className = "cadra-preview__controls";
  root.appendChild(controls);

  const stepBackButton = document.createElement("button");
  stepBackButton.type = "button";
  stepBackButton.className = "cadra-preview__step-back";
  stepBackButton.textContent = "<";
  controls.appendChild(stepBackButton);

  const playPauseButton = document.createElement("button");
  playPauseButton.type = "button";
  playPauseButton.className = "cadra-preview__play-pause";
  playPauseButton.textContent = "Play";
  controls.appendChild(playPauseButton);

  const stepForwardButton = document.createElement("button");
  stepForwardButton.type = "button";
  stepForwardButton.className = "cadra-preview__step-forward";
  stepForwardButton.textContent = ">";
  controls.appendChild(stepForwardButton);

  // A plain div, not a native <input type="range">: a native range input
  // snaps to a frame internally on its own, which would bypass
  // pointerPositionToFrame entirely. Building the track by hand means
  // pointer interaction genuinely goes through that pure function (and is
  // directly testable against synthetic track bounds, since no DOM test
  // environment implements real layout).
  const scrubberTrack = document.createElement("div");
  scrubberTrack.className = "cadra-preview__scrubber";
  scrubberTrack.setAttribute("role", "slider");
  scrubberTrack.setAttribute("aria-valuemin", "0");
  scrubberTrack.setAttribute("aria-valuemax", String(Math.max(durationInFrames - 1, 0)));
  scrubberTrack.setAttribute("aria-valuenow", "0");
  const scrubberFill = document.createElement("div");
  scrubberFill.className = "cadra-preview__scrubber-fill";
  scrubberTrack.appendChild(scrubberFill);
  controls.appendChild(scrubberTrack);

  const frameReadout = document.createElement("span");
  frameReadout.className = "cadra-preview__frame-readout";
  frameReadout.textContent = formatFrameReadout(0, durationInFrames);
  controls.appendChild(frameReadout);

  const fpsReadout = document.createElement("span");
  fpsReadout.className = "cadra-preview__fps-readout";
  fpsReadout.textContent = formatFpsReadout(fps);
  controls.appendChild(fpsReadout);

  container.appendChild(root);

  // Container must be focusable to receive the keydown listener below,
  // without clobbering a tabindex a host already set deliberately. Tracked
  // so dispose() only removes the attribute it was the one to add.
  const addedTabindex = !container.hasAttribute("tabindex");
  if (addedTabindex) {
    container.setAttribute("tabindex", "0");
  }

  // --- UI <-> Transport wiring ---

  function setPlayPauseButtonLabel(isPlaying: boolean): void {
    playPauseButton.textContent = isPlaying ? "Pause" : "Play";
  }

  function updateReadouts(frame: number): void {
    scrubberTrack.setAttribute("aria-valuenow", String(frame));
    const lastFrame = Math.max(durationInFrames - 1, 0);
    const fillPercent = lastFrame > 0 ? (frame / lastFrame) * 100 : 0;
    scrubberFill.style.width = `${fillPercent}%`;
    frameReadout.textContent = formatFrameReadout(frame, durationInFrames);
  }

  function requestSeek(frame: number): void {
    if (transport === undefined) {
      pendingFrameForGetFrame = frame;
      pendingActions.push({ kind: "seek", frame });
      return;
    }
    transport.seek(frame);
  }

  function requestPlay(): void {
    if (transport === undefined) {
      pendingActions.push({ kind: "play" });
      return;
    }
    transport.play();
  }

  function requestPause(): void {
    if (transport === undefined) {
      pendingActions.push({ kind: "pause" });
      return;
    }
    transport.pause();
  }

  // play()/pause() invoked through the UI must reflect isPlaying
  // immediately, not only on the next frameChanged, so this updates the
  // label itself right after calling through to the Transport.
  function togglePlayPause(): void {
    if (transport === undefined) {
      requestPlay();
      return;
    }
    if (transport.isPlaying) {
      transport.pause();
    } else {
      transport.play();
    }
    setPlayPauseButtonLabel(transport.isPlaying);
  }

  playPauseButton.addEventListener("click", togglePlayPause);
  stepBackButton.addEventListener("click", () => {
    const current = transport?.currentFrame ?? pendingFrameForGetFrame;
    requestSeek(current - 1);
  });
  stepForwardButton.addEventListener("click", () => {
    const current = transport?.currentFrame ?? pendingFrameForGetFrame;
    requestSeek(current + 1);
  });

  // Mouse events (not Pointer Events / setPointerCapture): broader DOM test
  // environment support (jsdom implements neither PointerEvent nor
  // setPointerCapture as of this writing). Dragging is tracked by listening
  // on `document` for the duration of a drag, the conventional way to
  // implement a custom slider without relying on pointer capture.
  /** Maps a mouse event's clientX to a frame via pointerPositionToFrame, using the track's live bounding rect. */
  function seekToMousePosition(event: MouseEvent): void {
    const rect = scrubberTrack.getBoundingClientRect();
    const frame = pointerPositionToFrame(
      { trackLeft: rect.left, trackWidth: rect.width, pointerX: event.clientX },
      durationInFrames,
    );
    requestSeek(frame);
  }

  function handleDocumentMouseMove(event: MouseEvent): void {
    seekToMousePosition(event);
  }
  function handleDocumentMouseUp(): void {
    document.removeEventListener("mousemove", handleDocumentMouseMove);
    document.removeEventListener("mouseup", handleDocumentMouseUp);
  }
  function handleScrubberMouseDown(event: MouseEvent): void {
    seekToMousePosition(event);
    document.addEventListener("mousemove", handleDocumentMouseMove);
    document.addEventListener("mouseup", handleDocumentMouseUp);
  }

  scrubberTrack.addEventListener("mousedown", handleScrubberMouseDown);

  function handleKeydown(event: KeyboardEvent): void {
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayPause();
      return;
    }
    if (event.code === "ArrowLeft") {
      event.preventDefault();
      const current = transport?.currentFrame ?? pendingFrameForGetFrame;
      requestSeek(current - 1);
      return;
    }
    if (event.code === "ArrowRight") {
      event.preventDefault();
      const current = transport?.currentFrame ?? pendingFrameForGetFrame;
      requestSeek(current + 1);
    }
  }
  container.addEventListener("keydown", handleKeydown);

  // --- Responsive canvas sizing ---

  let lastAppliedSize: { width: number; height: number } | undefined;

  function applyContainerSize(containerWidth: number, containerHeight: number): void {
    const fitSize = computeAspectFitSize(
      { width: containerWidth, height: containerHeight },
      { width: compositionWidth, height: compositionHeight },
    );
    if (fitSize.width <= 0 || fitSize.height <= 0) {
      return;
    }
    const roundedWidth = Math.round(fitSize.width);
    const roundedHeight = Math.round(fitSize.height);
    if (
      lastAppliedSize !== undefined &&
      lastAppliedSize.width === roundedWidth &&
      lastAppliedSize.height === roundedHeight
    ) {
      return;
    }
    lastAppliedSize = { width: roundedWidth, height: roundedHeight };
    canvas.width = roundedWidth;
    canvas.height = roundedHeight;
    canvas.style.width = `${roundedWidth}px`;
    canvas.style.height = `${roundedHeight}px`;
    options.renderer.resize({ width: roundedWidth, height: roundedHeight });
  }

  let unobserveResize: UnobserveResizeFn | undefined = observeResize(root, (size) => {
    applyContainerSize(size.width, size.height);
  });

  // --- Renderer/Transport construction (async: renderer.init may be async) ---

  const initialSize = computeAspectFitSize(
    { width: root.clientWidth, height: root.clientHeight },
    { width: compositionWidth, height: compositionHeight },
  );
  const initSize =
    initialSize.width > 0 && initialSize.height > 0
      ? { width: Math.round(initialSize.width), height: Math.round(initialSize.height) }
      : { width: compositionWidth, height: compositionHeight };
  canvas.width = initSize.width;
  canvas.height = initSize.height;
  canvas.style.width = `${initSize.width}px`;
  canvas.style.height = `${initSize.height}px`;
  lastAppliedSize = initSize;

  void Promise.resolve(options.renderer.init(canvas, initSize)).then(() => {
    if (isDisposed) {
      // dispose() ran while init was in flight: never construct a Transport
      // (which would immediately render a frame) against a torn-down
      // renderer/canvas.
      return;
    }

    const createdTransport = createTransport({
      project: options.project,
      compositionId: options.compositionId,
      renderer: options.renderer,
      loop: options.loop,
      playbackRate: options.playbackRate,
      seed: options.seed,
      now: options.now,
      scheduleFrame: options.scheduleFrame,
      cancelFrame: options.cancelFrame,
      isFrameReady: options.isFrameReady,
    });
    transport = createdTransport;

    createdTransport.on("frameChanged", (frame) => {
      pendingFrameForGetFrame = frame;
      updateReadouts(frame);
    });
    createdTransport.on("ended", () => {
      setPlayPauseButtonLabel(false);
    });

    setPlayPauseButtonLabel(createdTransport.isPlaying);
    updateReadouts(createdTransport.currentFrame);

    for (const action of pendingActions) {
      if (action.kind === "seek") {
        createdTransport.seek(action.frame);
      } else if (action.kind === "play") {
        createdTransport.play();
      } else {
        createdTransport.pause();
      }
    }
    pendingActions.length = 0;
    setPlayPauseButtonLabel(createdTransport.isPlaying);
  });

  function dispose(): void {
    if (isDisposed) {
      return;
    }
    isDisposed = true;

    unobserveResize?.();
    unobserveResize = undefined;

    container.removeEventListener("keydown", handleKeydown);
    scrubberTrack.removeEventListener("mousedown", handleScrubberMouseDown);
    // In case dispose() runs mid-drag: these are otherwise only removed by
    // handleDocumentMouseUp itself.
    document.removeEventListener("mousemove", handleDocumentMouseMove);
    document.removeEventListener("mouseup", handleDocumentMouseUp);
    if (addedTabindex) {
      container.removeAttribute("tabindex");
    }

    transport?.dispose();
    options.renderer.dispose();

    root.remove();
  }

  return {
    seek(frame: number) {
      if (isDisposed) {
        return;
      }
      requestSeek(frame);
    },
    play() {
      if (isDisposed) {
        return;
      }
      requestPlay();
    },
    pause() {
      if (isDisposed) {
        return;
      }
      requestPause();
    },
    getFrame() {
      return transport?.currentFrame ?? pendingFrameForGetFrame;
    },
    dispose,
  };
}
