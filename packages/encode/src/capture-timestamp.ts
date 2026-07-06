import { frameToTime } from "@cadra/core";

/**
 * Microseconds per second, the unit WebCodecs' `VideoFrame.timestamp`,
 * `EncodedVideoChunk.timestamp`, `AudioData.timestamp`, and
 * `EncodedAudioChunk.timestamp` are all defined in: video and audio share
 * exactly the same WebCodecs timestamp convention, which is precisely what
 * lets both tracks be aligned to the same zero point and the same
 * underlying time base once muxed (this phase's own acceptance criterion).
 * Exported so `encode-audio.ts`'s sample-offset-based timestamps
 * (`secondsToMicrosecondTimestamp`, below) and `frameToMicrosecondTimestamp`
 * (frame-offset-based, for video) both convert through this one shared
 * constant, rather than each independently hardcoding the same `1_000_000`
 * value.
 */
export const MICROSECONDS_PER_SECOND = 1_000_000;

/**
 * Converts a time in seconds to a whole-microsecond WebCodecs timestamp,
 * rounded to the nearest integer: the general-purpose half of the
 * conversion `frameToMicrosecondTimestamp` (below) specializes to a frame
 * index. Used directly by `encode-audio.ts`'s `chunkAudioBuffer`, whose
 * natural unit is a sample offset (`frameOffset / sampleRate` seconds), not
 * a frame index at some fps: audio has no fps of its own to convert
 * through `frameToTime`, so this is the shared conversion both the video
 * and audio timestamp paths ultimately reduce to, once each has computed
 * its own real-valued seconds offset.
 */
export function secondsToMicrosecondTimestamp(seconds: number): number {
  return Math.round(seconds * MICROSECONDS_PER_SECOND);
}

/**
 * Converts an integer frame index to a whole-microsecond WebCodecs
 * timestamp at the given frame rate: `frameToTime(frame, fps)` (seconds,
 * exact) scaled to microseconds and rounded to the nearest integer, since
 * `VideoFrame.timestamp` is defined as an integer microsecond count and
 * `frame / fps` in seconds is not exact at every fps (e.g. 1/3 for a 3fps
 * composition).
 *
 * Reuses `frameToTime` rather than recomputing `frame / fps` directly: it
 * is already the single definition of frame-to-time conversion this
 * codebase uses (`@cadra/core`'s `FrameContext` construction included), so
 * this module has no independent opinion about it. Delegates the final
 * seconds-to-microseconds step to `secondsToMicrosecondTimestamp`, the same
 * shared conversion `encode-audio.ts`'s sample-offset-based timestamps use.
 *
 * Strictly monotonic in `frame` for any fixed, positive `fps`: consecutive
 * frames are `1_000_000 / fps` microseconds apart, which is at least
 * `1` for every fps this codebase supports (up to 1,000,000fps), so
 * rounding never collapses two distinct frames to the same timestamp.
 */
export function frameToMicrosecondTimestamp(frame: number, fps: number): number {
  return secondsToMicrosecondTimestamp(frameToTime(frame, fps));
}
