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

/**
 * webm-muxer's own `Segment.Info.Duration` is, by that library's own
 * implementation (not a Matroska spec requirement, and not something this
 * package's `muxToWebmBuffer`/`muxToWebmStream` can influence through any
 * documented option), tracked as "the highest video chunk timestamp seen so
 * far, converted to milliseconds," with no addition for that last chunk's
 * own duration. Concretely: `floor(lastChunk.timestamp / 1000)`, where
 * `timestamp` is in the WebCodecs-standard whole microseconds this
 * codebase's chunks always carry (see `capture-timestamp.ts`).
 *
 * This makes webm-muxer's `Duration` intrinsically one frame-duration
 * short of `expectedWebmDurationTicks(durationInFrames, fps)` (the
 * spec-conformant, "full presentation span including the last frame's own
 * extent" value): the last frame, at index `durationInFrames - 1`, starts
 * at `(durationInFrames - 1) / fps` seconds but is never credited with the
 * further `1 / fps` seconds it itself spans. `mux-webm.ts`'s own doc
 * documents this as a known limitation of the underlying library (distinct
 * from, and in addition to, WebM having no faststart equivalent); this
 * function exists so a test (or any caller who needs to predict
 * webm-muxer's literal output rather than the spec-conformant ideal) has an
 * exact, single source of truth for it, rather than an approximation that
 * could disagree by a rounding-direction difference.
 */
export function expectedWebmMuxerDurationTicksFromLastChunkTimestamp(
  lastChunkTimestampMicroseconds: number,
): number {
  const MICROSECONDS_PER_MILLISECOND = 1000;
  return Math.floor(lastChunkTimestampMicroseconds / MICROSECONDS_PER_MILLISECOND);
}
