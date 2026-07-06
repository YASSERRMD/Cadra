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
 * `muxToMp4Blob`/`muxToMp4Buffer`/`muxToMp4Stream` and `muxToWebmBlob`/
 * `muxToWebmBuffer`/`muxToWebmStream` are the third stage: given
 * `encodeFrames`'s `EncodedChunkResult` stream, they multiplex it into a
 * standard MP4 (via `mp4-muxer`) or WebM (via `webm-muxer`) container,
 * either fully in memory (`*Buffer`/`*Blob`, for a browser download link or
 * an `ArrayBuffer` a caller wants directly) or written incrementally to a
 * Node `Writable`/spec `WritableStream` (`*Stream`, for `@cadra/headless`'s
 * server-side rendering path). `readMp4MovieHeader`/`readWebmSegmentInfo`
 * parse a produced file's own container-level duration/timescale metadata
 * back out, for validating muxer output against what was fed into it
 * without needing a real media player available.
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
export type { Mp4VideoCodec, WebmVideoCodec } from "./mux-codec-mapping.js";
export {
  toMp4VideoCodec,
  toWebmVideoCodec,
  UnsupportedMuxCodecError,
  Vp8NotSupportedInMp4Error,
} from "./mux-codec-mapping.js";
export type { MuxMp4Options } from "./mux-mp4.js";
export { muxToMp4Blob, muxToMp4Buffer, muxToMp4Stream } from "./mux-mp4.js";
export type { NodeWritableLike, WebWritableStreamLike } from "./mux-stream-target.js";
export { NonSequentialMuxWriteError, toSequentialOnData } from "./mux-stream-target.js";
export {
  expectedDurationSeconds,
  expectedMp4DurationTicks,
  expectedWebmDurationTicks,
  WEBM_TIMESTAMP_SCALE_NANOSECONDS,
} from "./mux-timescale.js";
export type { Mp4MovieHeader } from "./mux-validate-mp4.js";
export { Mp4ParseError, readMp4MovieHeader } from "./mux-validate-mp4.js";
export type { WebmSegmentInfo } from "./mux-validate-webm.js";
export { readWebmSegmentInfo, WebmParseError } from "./mux-validate-webm.js";
export type { MuxWebmOptions } from "./mux-webm.js";
export { muxToWebmBlob, muxToWebmBuffer, muxToWebmStream } from "./mux-webm.js";
export type { IsConfigSupportedFn, VideoEncoderConstructor } from "./video-encoder-factory.js";
export {
  getGlobalIsConfigSupported,
  getGlobalVideoEncoderConstructor,
} from "./video-encoder-factory.js";
export type { VideoFrameConstructor, WebCodecsDetector } from "./video-frame-factory.js";
export { detectWebCodecsSupport, getGlobalVideoFrameConstructor } from "./video-frame-factory.js";
