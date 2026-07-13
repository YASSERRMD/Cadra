/**
 * @cadra/encode
 *
 * WebCodecs-based frame/audio capture, encoding, and muxing used to turn
 * rendered Cadra frames and a composition's audio mixdown into deterministic
 * MP4/WebM output.
 *
 * `captureFrames` is the first video stage: given `@cadra/headless`'s
 * `renderComposition` output (an `AsyncGenerator<RenderedFrame>`), it
 * converts each rendered frame's `PixelBuffer` into a WebCodecs `VideoFrame`
 * with a precise, monotonic microsecond timestamp derived from frame index
 * and fps, falling back to yielding the raw `PixelBuffer` when WebCodecs is
 * unavailable in this environment. See its own module doc for the full
 * ownership contract (the consumer closes every yielded `VideoFrame`) and
 * the default color space it stamps onto constructed frames.
 *
 * `encodeFrames` is the second video stage: given `captureFrames`'s
 * `CapturedVideoFrame` output, it configures a `VideoEncoder` (probing a
 * codec preference list for the first supported one), encodes each frame in
 * order (forcing keyframes at a configurable interval), applies backpressure
 * off `encoder.encodeQueueSize`/`dequeue` so encoding never falls arbitrarily
 * far behind rendering, and streams out `EncodedChunkResult`s as they
 * become available. It closes every `videoFrame` it receives (continuing
 * `captureFrames`'s ownership contract) and flushes/closes the encoder on
 * completion or early termination.
 *
 * `renderAudioMixdown` is the first audio stage: given `@cadra/core`'s
 * `resolveAudioMixdown` output (Phase 16's flat, deterministic description of
 * a composition's audio timeline), it schedules every segment onto an
 * `OfflineAudioContextLike` (an injectable structural interface over a real
 * `OfflineAudioContext`, mirroring `@cadra/player`'s `AudioContextLike`) and
 * renders the full composition's duration in one pass, producing an
 * `AudioBufferLike` aligned to frame 0 regardless of where the mixdown's own
 * content actually starts or ends.
 *
 * `encodeAudio` is the second audio stage: given `renderAudioMixdown`'s
 * `AudioBufferLike`, it chunks the rendered PCM into `AudioData` objects,
 * configures a WebCodecs `AudioEncoder` (AAC for an MP4 target, Opus for a
 * WebM target), applies the same queue-size-driven backpressure
 * `encodeFrames` applies on the video side, and streams out
 * `EncodedAudioChunkResult`s.
 *
 * `muxToMp4Blob`/`muxToMp4Buffer`/`muxToMp4Stream` and `muxToWebmBlob`/
 * `muxToWebmBuffer`/`muxToWebmStream` are the third, shared stage: given
 * `encodeFrames`'s `EncodedChunkResult` stream (and, optionally,
 * `encodeAudio`'s `EncodedAudioChunkResult` stream), they multiplex both into
 * a standard MP4 (via `mp4-muxer`) or WebM (via `webm-muxer`) container,
 * either fully in memory (`*Buffer`/`*Blob`, for a browser download link or
 * an `ArrayBuffer` a caller wants directly) or written incrementally to a
 * Node `Writable`/spec `WritableStream` (`*Stream`, for `@cadra/headless`'s
 * server-side rendering path). A composition with no audio (`resolveAudioMixdown`'s
 * `segments` empty) simply omits the optional audio track argument, producing
 * a valid video-only file with no wasted silent-track encoding.
 * `readMp4MovieHeader`/`readMp4TrackTimescale`/`readMp4AudioTrackTimescale`/
 * `readWebmSegmentInfo`/`readWebmTrackLastBlockEndTimestamp` parse a produced
 * file's own container-level duration/timescale metadata back out (for both
 * tracks, where the container format exposes a per-track value), for
 * validating muxer output against what was fed into it without needing a
 * real media player available.
 *
 * `runBrowserHeadlessRender` (`browser-headless-render-entry.ts`) is Phase
 * 23's browser-side entry point: a video-only pipeline (real `createRenderer()`
 * + a real canvas-snapshot `readPixels`, through `renderComposition` ->
 * `captureFrames` -> `encodeFrames` -> `muxToMp4Stream`/`muxToWebmStream`)
 * meant to run inside a headless-Chromium page, never imported by other
 * TypeScript source in this workspace. `@cadra/headless`'s server
 * orchestrator bundles it (via esbuild, pointed at
 * `BROWSER_HEADLESS_RENDER_ENTRY_PATH`, this compiled file's own resolved
 * path) and injects the bundle into a real page; see that package's own
 * `bundle-browser-entry.ts`/`render-composition-headless-server.ts` docs for
 * why the bundling logic itself lives there instead of here (avoiding a
 * circular `@cadra/headless` <-> `@cadra/encode` workspace dependency, since
 * this package already depends on `@cadra/headless` for `renderComposition`).
 *
 * Phase 25 additively exports a render job orchestrator wiring
 * (`render-job.ts`): `submitEncodedRenderJob`/`resumeEncodedRenderJob` wrap
 * `@cadra/headless`'s generic `submitRenderJob`/`resumeRenderJob` (frame-range
 * splitting, bounded-concurrency worker pool, per-range retry/resume, job
 * status) with the concrete pipeline this package owns: each range renders
 * and encodes independently, inside its own headless browser instance, via a
 * new sibling browser-side entry point (`runBrowserHeadlessRenderRange`,
 * using `renderComposition`'s new `startFrame`/`endFrame` sub-range support),
 * returning its `EncodedChunkResult`s as structured-clone-safe
 * `SerializedEncodedChunk`s. Once every range succeeds, every range's
 * segment is concatenated in frame order and fed through exactly one final
 * `muxToMp4Stream`/`muxToWebmStream` pass, i.e. lossless segment
 * concatenation with no per-range container file ever produced. See
 * `render-job.ts`'s own module doc for the full design, including exactly
 * what level of range-parallel-vs-sequential equivalence is (and is not)
 * guaranteed.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/encode";

export type { AudioCodecPreference, AudioCodecProbeTarget } from "./audio-codec-probe.js";
export {
  DEFAULT_AUDIO_CODEC_PREFERENCES,
  NoSupportedAudioCodecError,
  probeSupportedAudioCodec,
} from "./audio-codec-probe.js";
export type { AudioEncoderConstructor, IsAudioConfigSupportedFn } from "./audio-encoder-factory.js";
export {
  getGlobalAudioEncoderConstructor,
  getGlobalIsAudioConfigSupported,
} from "./audio-encoder-factory.js";
export type {
  BrowserHeadlessRenderConfig,
  BrowserHeadlessRenderRangeConfig,
} from "./browser-headless-render-entry.js";
export {
  runBrowserHeadlessRender,
  runBrowserHeadlessRenderRange,
} from "./browser-headless-render-entry.js";
export { BROWSER_HEADLESS_RENDER_ENTRY_PATH } from "./browser-headless-render-entry-path.js";
export type {
  CapturedFrame,
  CapturedPixelBuffer,
  CapturedVideoFrame,
  CaptureFramesOptions,
} from "./capture-frames.js";
export { captureFrames, DEFAULT_CAPTURE_COLOR_SPACE } from "./capture-frames.js";
export {
  frameToMicrosecondTimestamp,
  MICROSECONDS_PER_SECOND,
  secondsToMicrosecondTimestamp,
} from "./capture-timestamp.js";
export type { CodecPreference, CodecProbeTarget } from "./codec-probe.js";
export {
  DEFAULT_CODEC_PREFERENCES,
  NoSupportedCodecError,
  probeSupportedCodec,
} from "./codec-probe.js";
export type { EncodeAudioOptions, EncodedAudioChunkResult } from "./encode-audio.js";
export {
  DEFAULT_AUDIO_CHUNK_FRAMES,
  DEFAULT_MAX_AUDIO_QUEUE_SIZE,
  encodeAudio,
  WebCodecsUnavailableForAudioEncodingError,
} from "./encode-audio.js";
export type { EncodedChunkResult, EncodeFramesOptions } from "./encode-frames.js";
export {
  DEFAULT_KEYFRAME_INTERVAL_FRAMES,
  DEFAULT_MAX_QUEUE_SIZE,
  encodeFrames,
  WebCodecsUnavailableForEncodingError,
} from "./encode-frames.js";
export type { DecodedVideoFrame, VideoFrameSampleRequest } from "./ffmpeg-video-frame-decoder.js";
export { decodeVideoFramesWithFfmpeg, FfmpegNotFoundError } from "./ffmpeg-video-frame-decoder.js";
export type { MergedChunkResult } from "./mux-audio-video-merge.js";
export { mergeVideoAndAudioChunks } from "./mux-audio-video-merge.js";
export type { RawChunkBytes } from "./mux-chunk-bytes.js";
export {
  extractRawAudioChunkBytes,
  extractRawChunkBytes,
  MissingAudioChunkDurationError,
  MissingChunkDurationError,
} from "./mux-chunk-bytes.js";
export type {
  Mp4AudioCodec,
  Mp4VideoCodec,
  WebmAudioCodec,
  WebmVideoCodec,
} from "./mux-codec-mapping.js";
export {
  toMp4AudioCodec,
  toMp4VideoCodec,
  toWebmAudioCodec,
  toWebmVideoCodec,
  UnsupportedMuxAudioCodecError,
  UnsupportedMuxCodecError,
  Vp8NotSupportedInMp4Error,
} from "./mux-codec-mapping.js";
export type { MuxMp4AudioTrackOptions, MuxMp4Options } from "./mux-mp4.js";
export { muxToMp4Blob, muxToMp4Buffer, muxToMp4Stream } from "./mux-mp4.js";
export type {
  NodeWritableLike,
  SequentialOnDataTarget,
  WebWritableStreamLike,
} from "./mux-stream-target.js";
export { NonSequentialMuxWriteError, toSequentialOnData } from "./mux-stream-target.js";
export {
  expectedDurationSeconds,
  expectedMp4DurationTicks,
  expectedWebmDurationTicks,
  expectedWebmMuxerDurationTicksFromLastChunkTimestamp,
  WEBM_TIMESTAMP_SCALE_NANOSECONDS,
} from "./mux-timescale.js";
export type { Mp4MovieHeader, Mp4TrackHandlerType } from "./mux-validate-mp4.js";
export {
  Mp4ParseError,
  readMp4AudioFragmentedDurationTicks,
  readMp4AudioTrackTimescale,
  readMp4FragmentedDurationTicks,
  readMp4MovieHeader,
  readMp4TrackTimescale,
} from "./mux-validate-mp4.js";
export type { WebmSegmentInfo, WebmTrackType } from "./mux-validate-webm.js";
export {
  readWebmSegmentInfo,
  readWebmTrackLastBlockEndTimestamp,
  WebmParseError,
} from "./mux-validate-webm.js";
export type { MuxWebmAudioTrackOptions, MuxWebmOptions } from "./mux-webm.js";
export { muxToWebmBlob, muxToWebmBuffer, muxToWebmStream } from "./mux-webm.js";
export type {
  AudioBufferLike,
  DefaultOfflineAudioContextOptions,
  OfflineAudioBufferSourceNodeLike,
  OfflineAudioContextLike,
  OfflineAudioNodeLike,
  OfflineAudioParamLike,
  OfflineGainNodeLike,
} from "./offline-audio-context-like.js";
export { createDefaultOfflineAudioContextLike } from "./offline-audio-context-like.js";
export type { RenderAudioMixdownOptions, ResolveAudioBufferFn } from "./render-audio-mixdown.js";
export {
  DEFAULT_RENDER_CHANNEL_COUNT,
  DEFAULT_RENDER_SAMPLE_RATE,
  renderAudioMixdown,
} from "./render-audio-mixdown.js";
export type { EncodedRenderJobHandle, SubmitEncodedRenderJobOptions } from "./render-job.js";
export {
  buildEnvironmentRegistryForProject,
  buildLutRegistryForProject,
  buildModelRegistryForProject,
  buildSatoriLayerRenderRegistryForProject,
  buildTextRenderRegistryForProject,
  buildTextureRegistryForProject,
  buildVideoFrameRegistryForProject,
  DEFAULT_RANGE_TIMEOUT_MS,
  getEncodedRenderJobStatus,
  resumeEncodedRenderJob,
  submitEncodedRenderJob,
} from "./render-job.js";
export type { SerializedEncodedChunk } from "./serialized-encoded-chunk.js";
export {
  deserializeEncodedChunkResult,
  serializeEncodedChunk,
} from "./serialized-encoded-chunk.js";
export type { IsConfigSupportedFn, VideoEncoderConstructor } from "./video-encoder-factory.js";
export {
  getGlobalIsConfigSupported,
  getGlobalVideoEncoderConstructor,
} from "./video-encoder-factory.js";
export type { VideoFrameConstructor, WebCodecsDetector } from "./video-frame-factory.js";
export { detectWebCodecsSupport, getGlobalVideoFrameConstructor } from "./video-frame-factory.js";
