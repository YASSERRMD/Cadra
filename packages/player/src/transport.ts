import {
  createFrameContext,
  type Project,
  resolveSceneAtFrame,
  type SceneState,
} from "@cadra/core";
import type { Renderer } from "@cadra/renderer";

/**
 * Events a `Transport` emits, and the payload each carries.
 *
 * `frameChanged` fires whenever the resolved frame actually changes (not
 * once per scheduled tick: a tick whose computed frame is unchanged from the
 * previous tick is a no-op, see `Transport`'s own module doc). `ended` fires
 * exactly once per playthrough when playback reaches `durationInFrames - 1`
 * without `loop`. `buffering` fires with `true` when the frame about to be
 * shown is reported not-ready by the injected readiness hook, and again with
 * `false` once playback resumes.
 */
export interface TransportEventMap {
  frameChanged: number;
  ended: void;
  buffering: boolean;
}

type TransportEventName = keyof TransportEventMap;
type TransportEventHandler<Name extends TransportEventName> = (
  payload: TransportEventMap[Name],
) => void;

/**
 * Returns the current wall-clock time in milliseconds, injectable so tests
 * can drive playback deterministically without real timers. Defaults to
 * `performance.now`.
 */
export type NowFn = () => number;

/** Schedules `callback` to run on the next animation tick, returning a handle `cancelFrame` can use to cancel it. */
export type ScheduleFrameFn = (callback: () => void) => number;
/** Cancels a tick previously scheduled by `scheduleFrame`. */
export type CancelFrameFn = (handle: number) => void;

/**
 * Reports whether `frame` is ready to be shown, e.g. because every asset it
 * references has finished loading. Defaults to "always ready" (`() => true`),
 * matching a scene with no asset-readiness concerns yet.
 *
 * A plain synchronous boolean callback, not `@cadra/core`'s async
 * `Pending`/`waitForAssets` shape directly: the transport's tick loop is
 * itself synchronous (one `scheduleFrame` callback per tick), so a readiness
 * check needs an answer immediately, not a `Promise` to await mid-tick.
 * Anything that already tracks asset readiness via `Pending`/`waitForAssets`
 * (e.g. resolving a promise into a flag) can trivially expose that state
 * through this same boolean shape; the reverse (turning a synchronous
 * boolean into a `waitForAssets`-shaped `Pending`) is just as trivial via an
 * already-resolved-or-pending promise, so nothing this hook could express is
 * lost by keeping it synchronous.
 */
export type IsFrameReadyFn = (frame: number) => boolean;

/** Options accepted by `createTransport`. */
export interface TransportOptions {
  /** The project to play back. */
  project: Project;
  /** Which of `project`'s compositions to play. */
  compositionId: string;
  /** Renderer to draw each resolved frame into. Must already be `init`-ed. */
  renderer: Renderer;
  /** Whether playback wraps back to frame 0 at the end instead of stopping. Defaults to `false`. */
  loop?: boolean;
  /** Initial playback rate; 1 is real-time. Defaults to `1`. */
  playbackRate?: number;
  /** Seed for the `FrameContext` passed to `resolveSceneAtFrame`/`renderFrame`. Defaults to a fixed literal. */
  seed?: string | number;
  /** Wall-clock time source. Defaults to `performance.now`. */
  now?: NowFn;
  /** Tick scheduler. Defaults to `requestAnimationFrame`, falling back to a `setTimeout`-based shim if unavailable. */
  scheduleFrame?: ScheduleFrameFn;
  /** Cancels a tick scheduled by `scheduleFrame`. Defaults to `cancelAnimationFrame`, matching whichever `scheduleFrame` default is in effect. */
  cancelFrame?: CancelFrameFn;
  /** Per-frame asset-readiness check. Defaults to always-ready. */
  isFrameReady?: IsFrameReadyFn;
}

/**
 * Live transport over one `Project` composition: play/pause/seek plus a
 * frame-accurate clock decoupled from tick cadence.
 *
 * The computed frame is always `startFrame + floor(elapsedSeconds * fps *
 * playbackRate)`, anchored at whichever wall-clock instant playback last
 * started or seeked from: never "advance by one frame per tick". This means
 * calling `tick` (internally, via `scheduleFrame`) an arbitrary number of
 * times covering the same total elapsed wall-clock time always lands on the
 * same final frame, regardless of how many ticks fired in between, which is
 * exactly what decouples the frame count from `requestAnimationFrame`'s own
 * real cadence.
 *
 * Frame *number* advancement (which frame the transport currently sits on)
 * is the only place wall-clock time enters: what a given frame *renders* is
 * still purely `resolveSceneAtFrame(project, compositionId, frame)`, so
 * nothing wall-clock-derived ever reaches scene evaluation itself.
 */
export interface Transport {
  /** Starts (or resumes) playback from the current frame. */
  play(): void;
  /** Stops advancing; the current frame stays resolved and rendered. */
  pause(): void;
  /** Jumps directly to `frame` (clamped to `[0, durationInFrames - 1]`), resolving and rendering it immediately. */
  seek(frame: number): void;
  /** Changes playback speed; does not affect what any given frame resolves to, only how fast the frame number advances. */
  setPlaybackRate(rate: number): void;
  /** Subscribes `handler` to `event`. */
  on<Name extends TransportEventName>(event: Name, handler: TransportEventHandler<Name>): void;
  /** Unsubscribes `handler` from `event`. */
  off<Name extends TransportEventName>(event: Name, handler: TransportEventHandler<Name>): void;
  /**
   * Cancels any in-flight scheduled tick (the same cleanup `pause()` already
   * does) and marks this transport disposed. Idempotent: calling it again is
   * a no-op.
   *
   * Every other method becomes a no-op after `dispose()` (not a throw): a
   * host's unmount cleanup routinely fires a trailing `pause()`/`seek()` from
   * an event handler that was already in flight when `dispose()` ran, and
   * that caller should not have to guard each such call. `on`/`off` in
   * particular still accept subscriptions without error, they simply never
   * fire again, since nothing this transport does post-dispose changes state.
   */
  dispose(): void;
  /** Whether `play()` has been called without a matching `pause()`/end-of-playback since. */
  readonly isPlaying: boolean;
  /** The frame currently resolved and rendered. */
  readonly currentFrame: number;
  /** Whether looping is enabled. Settable directly. */
  loop: boolean;
  /** The composition's frame rate, as looked up from `project`. */
  readonly fps: number;
  /** The composition's total length in frames, as looked up from `project`. */
  readonly durationInFrames: number;
}

/**
 * Tiny epsilon (a small fraction of one frame, at any plausible fps) added
 * before flooring in `computeElapsedFrame`, so IEEE-754 subtraction noise
 * never rounds a just-reached frame boundary down to the previous frame.
 * See `computeElapsedFrame`'s own doc for why this is needed.
 */
const FRAME_EPSILON = 1e-9;

/** Thrown by `createTransport` when `compositionId` does not name a composition in `project`. */
export class CompositionNotFoundForTransportError extends Error {
  constructor(compositionId: string) {
    super(`Transport: no composition with id "${compositionId}" in the given project.`);
    this.name = "CompositionNotFoundForTransportError";
  }
}

/** `requestAnimationFrame`/`cancelAnimationFrame` when available, else a `setTimeout`-based shim at a fixed ~60fps tick rate. */
function defaultScheduleFrame(): { scheduleFrame: ScheduleFrameFn; cancelFrame: CancelFrameFn } {
  if (typeof requestAnimationFrame === "function" && typeof cancelAnimationFrame === "function") {
    return {
      scheduleFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    };
  }
  return {
    scheduleFrame: (callback) => setTimeout(callback, 1000 / 60) as unknown as number,
    cancelFrame: (handle) => clearTimeout(handle),
  };
}

/** Creates a `Transport` driving `options.renderer` from `options.project`/`options.compositionId`. */
export function createTransport(options: TransportOptions): Transport {
  const composition = options.project.compositions.find(
    (candidate) => candidate.id === options.compositionId,
  );
  if (composition === undefined) {
    throw new CompositionNotFoundForTransportError(options.compositionId);
  }

  const { fps, durationInFrames } = composition;
  const seed = options.seed ?? "cadra-transport";
  const isFrameReady: IsFrameReadyFn = options.isFrameReady ?? (() => true);
  const envDefaults = defaultScheduleFrame();
  const now: NowFn = options.now ?? (() => performance.now());
  const scheduleFrame: ScheduleFrameFn = options.scheduleFrame ?? envDefaults.scheduleFrame;
  const cancelFrame: CancelFrameFn = options.cancelFrame ?? envDefaults.cancelFrame;

  let playbackRate = options.playbackRate ?? 1;
  let loop = options.loop ?? false;
  let currentFrame = 0;
  let isPlaying = false;
  let isBuffering = false;
  let hasEnded = false;
  let isDisposed = false;
  let scheduledHandle: number | undefined;

  // Anchor for the elapsed-time formula: reset on every play()/seek()/
  // setPlaybackRate() call, so "elapsed" always means "since the most recent
  // point the frame formula's inputs last changed", never since some earlier
  // point whose rate/frame no longer applies.
  let anchorNow = 0;
  let anchorFrame = 0;

  const handlers: { [Name in TransportEventName]: Set<TransportEventHandler<Name>> } = {
    frameChanged: new Set(),
    ended: new Set(),
    buffering: new Set(),
  };

  function emit<Name extends TransportEventName>(
    event: Name,
    payload: TransportEventMap[Name],
  ): void {
    for (const handler of handlers[event]) {
      handler(payload);
    }
  }

  /** Resolves and renders `frame`, unconditionally (no readiness check, no frame-changed diffing). */
  function renderFrameNumber(frame: number): void {
    const frameContext = createFrameContext({ frame, fps, durationInFrames, seed });
    const sceneState: SceneState = resolveSceneAtFrame(
      options.project,
      options.compositionId,
      frame,
    );
    options.renderer.renderFrame(sceneState, frameContext);
  }

  /** Resets the elapsed-time anchor to "now, at the current frame": the formula's zero point for whatever comes next. */
  function resetAnchor(): void {
    anchorNow = now();
    anchorFrame = currentFrame;
  }

  /**
   * The core formula: integer frame derived purely from elapsed wall-clock
   * time and fps, never from a tick count. `Math.floor` (not `Math.round`)
   * so a frame is only considered "reached" once its full duration has
   * actually elapsed, matching the half-open-window convention the rest of
   * the timeline engine uses for frame visibility.
   *
   * `FRAME_EPSILON` guards against floating-point subtraction noise in
   * `now() - anchorNow`: two IEEE-754 doubles a real frame duration apart
   * (e.g. exactly one 1000/30ms tick) can subtract to a value a few ULPs
   * short of the exact boundary (e.g. `0.9999999999999993` frames instead of
   * `1`), which `Math.floor` would otherwise round down to the *previous*
   * frame. Nudging by a tiny fixed epsilon before flooring only ever moves a
   * result that is already within that epsilon of the next integer frame; it
   * never advances a frame that has not, for all real purposes, actually
   * elapsed yet.
   */
  function computeElapsedFrame(): number {
    const elapsedSeconds = (now() - anchorNow) / 1000;
    return anchorFrame + Math.floor(elapsedSeconds * fps * playbackRate + FRAME_EPSILON);
  }

  /** Applies loop/clamp semantics to a raw (possibly out-of-range) computed frame. */
  function normalizeFrame(rawFrame: number): { frame: number; didEnd: boolean } {
    if (rawFrame >= durationInFrames) {
      if (loop) {
        const wrapped = durationInFrames > 0 ? rawFrame % durationInFrames : 0;
        return { frame: wrapped, didEnd: false };
      }
      return { frame: durationInFrames - 1, didEnd: true };
    }
    if (rawFrame < 0) {
      // seek()'s own clamp already prevents this in practice, but a
      // negative playbackRate (not otherwise disallowed) could reach here.
      return { frame: 0, didEnd: false };
    }
    return { frame: rawFrame, didEnd: false };
  }

  function tick(): void {
    if (!isPlaying) {
      return;
    }

    const { frame: candidateFrame, didEnd } = normalizeFrame(computeElapsedFrame());

    if (!isFrameReady(candidateFrame)) {
      if (!isBuffering) {
        isBuffering = true;
        emit("buffering", true);
      }
      // Freeze the elapsed-time anchor at the still-current frame while
      // buffering: time spent waiting for readiness must never itself
      // advance the frame count, so playback resumes exactly where it
      // paused rather than skipping ahead by however long buffering took.
      resetAnchor();
      scheduledHandle = scheduleFrame(tick);
      return;
    }
    if (isBuffering) {
      isBuffering = false;
      emit("buffering", false);
    }

    if (candidateFrame !== currentFrame) {
      currentFrame = candidateFrame;
      renderFrameNumber(currentFrame);
      emit("frameChanged", currentFrame);
    }

    if (didEnd) {
      isPlaying = false;
      if (!hasEnded) {
        hasEnded = true;
        emit("ended", undefined);
      }
      return;
    }

    scheduledHandle = scheduleFrame(tick);
  }

  function play(): void {
    if (isDisposed || isPlaying) {
      return;
    }
    // Starting again after a prior natural end (no loop) restarts from
    // frame 0, matching how a finished video's play button behaves; a
    // pause/resume mid-playback (hasEnded still false) instead just
    // continues from wherever seek/pause left currentFrame.
    if (hasEnded) {
      currentFrame = 0;
      hasEnded = false;
    }
    isPlaying = true;
    resetAnchor();
    scheduledHandle = scheduleFrame(tick);
  }

  function pause(): void {
    if (!isPlaying) {
      return;
    }
    isPlaying = false;
    if (scheduledHandle !== undefined) {
      cancelFrame(scheduledHandle);
      scheduledHandle = undefined;
    }
  }

  function dispose(): void {
    if (isDisposed) {
      return;
    }
    // Same in-flight-tick cleanup pause() already does, so a disposed
    // transport never leaves a scheduleFrame callback pending.
    pause();
    isDisposed = true;
  }

  function seek(frame: number): void {
    if (isDisposed) {
      return;
    }
    const clamped = Math.min(Math.max(Math.trunc(frame), 0), Math.max(durationInFrames - 1, 0));
    hasEnded = false;
    if (clamped !== currentFrame) {
      currentFrame = clamped;
      renderFrameNumber(currentFrame);
      emit("frameChanged", currentFrame);
    } else {
      // Seeking to the frame already showing still (re-)renders it: a
      // caller seeking to "where we already are" expects the frame to be
      // on screen, even if nothing about the resolved state changed.
      renderFrameNumber(currentFrame);
    }
    if (isPlaying) {
      resetAnchor();
    }
  }

  function setPlaybackRate(rate: number): void {
    if (isDisposed) {
      return;
    }
    if (isPlaying) {
      // Settle whatever frame the *old* rate had already reached (rendering
      // and emitting frameChanged if it differs from what is currently
      // shown, so currentFrame never silently diverges from the last
      // rendered/announced frame), then re-anchor there: the rate change
      // only affects advancement from this instant forward. Without
      // settling first, elapsed time already accrued under the old rate
      // would be retroactively rescaled by the new one.
      const settledFrame = normalizeFrame(computeElapsedFrame()).frame;
      if (settledFrame !== currentFrame) {
        currentFrame = settledFrame;
        renderFrameNumber(currentFrame);
        emit("frameChanged", currentFrame);
      }
      resetAnchor();
    }
    playbackRate = rate;
  }

  // Render the initial frame immediately, before any play()/seek() call, so
  // a freshly created Transport already shows something (frame 0) rather
  // than a blank target until the first tick.
  renderFrameNumber(currentFrame);

  return {
    play,
    pause,
    seek,
    setPlaybackRate,
    dispose,
    on(event, handler) {
      (handlers[event] as Set<typeof handler>).add(handler);
    },
    off(event, handler) {
      (handlers[event] as Set<typeof handler>).delete(handler);
    },
    get isPlaying() {
      return isPlaying;
    },
    get currentFrame() {
      return currentFrame;
    },
    get loop() {
      return loop;
    },
    set loop(value: boolean) {
      loop = value;
    },
    fps,
    durationInFrames,
  };
}
