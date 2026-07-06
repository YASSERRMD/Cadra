/**
 * @cadra/player
 *
 * Live transport for Cadra scenes: play/pause/seek over a `@cadra/core`
 * `Project` composition, with an integer frame clock derived purely from
 * elapsed wall-clock time and fps (never from tick count), driving
 * `@cadra/renderer`'s `Renderer.renderFrame` once per resolved frame change.
 *
 * `mountPreview` (Phase 14) builds on `Transport` into a framework-agnostic,
 * embeddable preview surface: a canvas, play/pause/step/scrub controls, a
 * frame/fps readout, keyboard shortcuts scoped to the mounted container, and
 * responsive letterboxed/pillarboxed canvas sizing. Its scrubber-position
 * and aspect-ratio-fit math (`./preview/scrubber-math.js`,
 * `./preview/aspect-fit.js`) are additively exported too, since they are
 * pure functions of plain numbers useful to a host building its own controls
 * on top of the same `Transport`.
 *
 * OffscreenCanvas worker rendering and audio synchronization (this package's
 * eventual full scope) land in later phases; `mountPreview` still renders on
 * the main thread and will need to relocate where the canvas/renderer
 * actually live once Phase 15 moves rendering into a worker.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/player";

export type { FitSize } from "./preview/aspect-fit.js";
export { computeAspectFitSize } from "./preview/aspect-fit.js";
export type { MountPreviewOptions, PreviewHandle } from "./preview/mount-preview.js";
export { mountPreview } from "./preview/mount-preview.js";
export type {
  ObservedSize,
  ObserveResizeFn,
  UnobserveResizeFn,
} from "./preview/resize-observation.js";
export { observeResizeWithResizeObserver } from "./preview/resize-observation.js";
export type { ScrubberPointerPosition } from "./preview/scrubber-math.js";
export { pointerPositionToFrame } from "./preview/scrubber-math.js";
export type {
  CancelFrameFn,
  IsFrameReadyFn,
  NowFn,
  ScheduleFrameFn,
  Transport,
  TransportEventMap,
  TransportOptions,
} from "./transport.js";
export { CompositionNotFoundForTransportError, createTransport } from "./transport.js";
