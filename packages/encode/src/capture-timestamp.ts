import { frameToTime } from "@cadra/core";

/**
 * Microseconds per second, the unit WebCodecs' `VideoFrame.timestamp` and
 * `EncodedVideoChunk.timestamp` are both defined in.
 */
const MICROSECONDS_PER_SECOND = 1_000_000;

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
 * this module has no independent opinion about it.
 *
 * Strictly monotonic in `frame` for any fixed, positive `fps`: consecutive
 * frames are `1_000_000 / fps` microseconds apart, which is at least
 * `1` for every fps this codebase supports (up to 1,000,000fps), so
 * rounding never collapses two distinct frames to the same timestamp.
 */
export function frameToMicrosecondTimestamp(frame: number, fps: number): number {
  return Math.round(frameToTime(frame, fps) * MICROSECONDS_PER_SECOND);
}
