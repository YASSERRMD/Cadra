/**
 * @cadra/player
 *
 * Live transport for Cadra scenes: play/pause/seek over a `@cadra/core`
 * `Project` composition, with an integer frame clock derived purely from
 * elapsed wall-clock time and fps (never from tick count), driving
 * `@cadra/renderer`'s `Renderer.renderFrame` once per resolved frame change.
 *
 * OffscreenCanvas worker rendering and audio synchronization (this package's
 * eventual full scope) land in later phases; this phase's `Transport` is the
 * first real playback surface, meant to be wrapped by a preview canvas/UI
 * (Phase 14) and later moved off the main thread (Phase 15).
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/player";

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
