/**
 * @cadra/encode
 *
 * WebCodecs-based frame capture, encoding, and muxing used to turn rendered
 * Cadra frames into deterministic MP4 output.
 *
 * `captureFrames` is the first stage: given `@cadra/headless`'s
 * `renderComposition` output (an `AsyncGenerator<RenderedFrame>`), it
 * converts each rendered frame's `PixelBuffer` into a WebCodecs `VideoFrame`
 * with a precise, monotonic microsecond timestamp derived from frame index
 * and fps, falling back to yielding the raw `PixelBuffer` when WebCodecs is
 * unavailable in this environment. See its own module doc for the full
 * ownership contract (the consumer closes every yielded `VideoFrame`) and
 * the default color space it stamps onto constructed frames.
 *
 * Encoding the yielded frames with a real `VideoEncoder` and muxing the
 * result into a container are later phases' jobs, not this one's: this
 * module's scope ends at "one `VideoFrame` (or raw `PixelBuffer` fallback)
 * per rendered frame, in order, with a correct timestamp."
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/encode";

export type {
  CapturedFrame,
  CapturedPixelBuffer,
  CapturedVideoFrame,
  CaptureFramesOptions,
} from "./capture-frames.js";
export { captureFrames, DEFAULT_CAPTURE_COLOR_SPACE } from "./capture-frames.js";
export { frameToMicrosecondTimestamp } from "./capture-timestamp.js";
export type { VideoFrameConstructor, WebCodecsDetector } from "./video-frame-factory.js";
export { detectWebCodecsSupport, getGlobalVideoFrameConstructor } from "./video-frame-factory.js";
