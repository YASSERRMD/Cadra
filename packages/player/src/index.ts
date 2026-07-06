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
 * `attachAudioToTransport` (Phase 16) synchronizes Web Audio playback of a
 * composition's `audioTracks` with a `Transport`'s frame clock: scheduling
 * `AudioBufferSourceNode`/`GainNode` pairs for whatever `AudioClip`s are
 * currently active, keeping them correctly trimmed/gain-shaped across
 * ordinary playback, and cleanly stopping/rescheduling them on seek, pause,
 * and re-play.
 *
 * OffscreenCanvas worker rendering (this package's remaining scope) lands in
 * a later phase; `mountPreview` still renders on the main thread and will
 * need to relocate where the canvas/renderer actually live once Phase 15's
 * worker rendering is wired all the way through.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/player";

export type {
  AttachAudioOptions,
  AudioTransportSync,
  ResolveAudioBufferFn,
} from "./audio/attach-audio.js";
export { attachAudioToTransport } from "./audio/attach-audio.js";
export type {
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  GainNodeLike,
} from "./audio/audio-context-like.js";
export { createDefaultAudioContextLike } from "./audio/audio-context-like.js";
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
