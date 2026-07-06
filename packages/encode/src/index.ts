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
 * `encodeFrames` is the second stage: given `captureFrames`'s
 * `CapturedVideoFrame` output, it configures a `VideoEncoder` (probing a
 * codec preference list for the first supported one), encodes each frame in
 * order (forcing keyframes at a configurable interval), applies backpressure
 * off `encoder.encodeQueueSize`/`dequeue` so encoding never falls arbitrarily
 * far behind rendering, and streams out `EncodedChunkResult`s as they
 * become available. It closes every `videoFrame` it receives (continuing
 * `captureFrames`'s ownership contract) and flushes/closes the encoder on
 * completion or early termination.
 *
 * Muxing the encoded chunks into a container (e.g. an MP4/WebM file) is a
 * later phase's job, not this one's: this module's scope ends at "encoded
 * chunks, in order, with the metadata needed to mux them."
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
export type { CodecPreference, CodecProbeTarget } from "./codec-probe.js";
export {
  DEFAULT_CODEC_PREFERENCES,
  NoSupportedCodecError,
  probeSupportedCodec,
} from "./codec-probe.js";
export type { EncodedChunkResult, EncodeFramesOptions } from "./encode-frames.js";
export {
  DEFAULT_KEYFRAME_INTERVAL_FRAMES,
  DEFAULT_MAX_QUEUE_SIZE,
  encodeFrames,
  WebCodecsUnavailableForEncodingError,
} from "./encode-frames.js";
export type { IsConfigSupportedFn, VideoEncoderConstructor } from "./video-encoder-factory.js";
export {
  getGlobalIsConfigSupported,
  getGlobalVideoEncoderConstructor,
} from "./video-encoder-factory.js";
export type { VideoFrameConstructor, WebCodecsDetector } from "./video-frame-factory.js";
export { detectWebCodecsSupport, getGlobalVideoFrameConstructor } from "./video-frame-factory.js";
