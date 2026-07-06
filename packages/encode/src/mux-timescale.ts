/**
 * Timescale and duration math shared by both the MP4 and WebM muxing paths,
 * so the two containers never independently derive slightly different
 * numbers from the same `fps`/`durationInFrames`.
 *
 * "Timescale" here means the same thing an MP4 `mvhd`/`mdhd` box or a WebM
 * `TimecodeScale` element means: a fixed integer number of ticks-per-second
 * that every chunk timestamp is expressed as a multiple of, once muxed. Both
 * target muxers already convert an `EncodedVideoChunk.timestamp` (whole
 * microseconds, this codebase's `frameToMicrosecondTimestamp` convention;
 * see `capture-timestamp.ts`) into their own container's native timescale
 * internally, so this module does not re-implement that conversion; it only
 * derives the *frame-rate-facing* timescale value each muxer's options
 * accept (`VideoOptions.frameRate` for mp4-muxer, `video.frameRate` for
 * webm-muxer) and the expected total duration to validate against.
 */

import { frameToTime } from "@cadra/core";

/**
 * Whole seconds a composition should occupy once muxed, derived the same way
 * `FrameContext.time`/`frameToTime` derive time from frame count: exactly
 * `durationInFrames / fps`. No rounding: this is the same exact division
 * `frameToTime` already performs (frame count doubling as "the frame just
 * past the last rendered one" is exactly the composition's duration in
 * seconds at this fps), so both `expectedMp4DurationTicks` and
 * `expectedWebmDurationTicks` below quantize from this same exact value
 * rather than from two independently-rounded intermediate results.
 */
export function expectedDurationSeconds(durationInFrames: number, fps: number): number {
  return frameToTime(durationInFrames, fps);
}

/**
 * MP4 box-level duration (an `mvhd`/`mdhd` `duration` field) is an integer
 * count of ticks at the track's/movie's timescale, not a floating point
 * seconds value. `timescale` is conventionally chosen as a small integer
 * multiple of `fps` (mp4-muxer picks one internally from the frame
 * timestamps it receives), so this helper's job is only to state the
 * expected tick count a validator should find once a composition of
 * `durationInFrames` frames at `fps` has been muxed at a given `timescale`:
 * `round(durationInFrames / fps * timescale)`.
 *
 * Rounding (`Math.round`, not truncation) matches how a muxer itself must
 * quantize a real-valued duration down to an integer tick count; using the
 * same rounding rule here means a validator comparing this expected value
 * against a muxed file's actual `mvhd`/`mdhd` duration is comparing against
 * what the muxer was mathematically obligated to produce, not an
 * independent approximation that could disagree by a rounding-direction
 * difference alone.
 */
export function expectedMp4DurationTicks(
  durationInFrames: number,
  fps: number,
  timescale: number,
): number {
  return Math.round(expectedDurationSeconds(durationInFrames, fps) * timescale);
}

/**
 * Nanoseconds per tick Matroska's `TimestampScale` element defaults to, and
 * the fixed value both webm-muxer and this package's own `muxToWebmBuffer`/
 * `muxToWebmStream` always request (see `mux-webm.ts`). Exposed as a named
 * constant (not just inlined into `expectedWebmDurationTicks`'s default
 * parameter) so a test asserting "the container's TimestampScale matches
 * what the encoder used" has a single source of truth to compare against,
 * the same way `DEFAULT_KEYFRAME_INTERVAL_FRAMES` etc. are in
 * `encode-frames.ts`.
 */
export const WEBM_TIMESTAMP_SCALE_NANOSECONDS = 1_000_000;

/**
 * WebM/Matroska's `Segment.Info.Duration` element is, per the Matroska
 * spec, a value in `TimestampScale`-ticks: multiplying it by
 * `TimestampScale` (nanoseconds per tick) gives the duration in
 * nanoseconds. This is the WebM-side counterpart to
 * `expectedMp4DurationTicks`, quantizing the same
 * `expectedDurationSeconds(durationInFrames, fps)` value down to an integer
 * tick count at a given `timestampScaleNanoseconds` (defaulting to
 * `WEBM_TIMESTAMP_SCALE_NANOSECONDS`, the fixed value this package's own
 * muxing functions always request): `round(durationInFrames / fps * 1e9 /
 * timestampScaleNanoseconds)`.
 */
export function expectedWebmDurationTicks(
  durationInFrames: number,
  fps: number,
  timestampScaleNanoseconds: number = WEBM_TIMESTAMP_SCALE_NANOSECONDS,
): number {
  const NANOSECONDS_PER_SECOND = 1_000_000_000;
  return Math.round(
    (expectedDurationSeconds(durationInFrames, fps) * NANOSECONDS_PER_SECOND) /
      timestampScaleNanoseconds,
  );
}
