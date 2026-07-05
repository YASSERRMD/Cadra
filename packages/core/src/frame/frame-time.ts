/**
 * Conversions between integer frame indices and time in seconds.
 *
 * `frameToTime` is exact: frame rate is defined as frames per second, so time
 * is just `frame / fps`. `timeToFrame` is the inverse direction, but time in
 * seconds does not divide evenly into frames in general, so it needs an
 * explicit rounding rule to land back on an integer frame index.
 */

/**
 * Converts an integer frame index to time in seconds at the given frame
 * rate. Exact: no rounding is involved, since `frame / fps` is already the
 * definition of frame rate.
 */
export function frameToTime(frame: number, fps: number): number {
  return frame / fps;
}

/**
 * Converts a time in seconds to the integer frame index at the given frame
 * rate.
 *
 * Rounding convention: nearest-frame, with exact halfway points (e.g. time
 * that is precisely half a frame duration past a frame boundary) rounding up
 * to the later frame. This matches `Math.round`'s standard "round half up"
 * behavior, so it needs no special-casing here, and it is the same rounding
 * rule most timeline UIs use when snapping a scrub position to a frame.
 */
export function timeToFrame(time: number, fps: number): number {
  return Math.round(time * fps);
}
