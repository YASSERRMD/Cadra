/**
 * Plain-number inputs describing a scrubber track's on-screen extent and
 * where a pointer landed on it. Deliberately not a `DOMRect`/`PointerEvent`:
 * a real layout engine is not available in the DOM test environment this
 * package tests against (`getBoundingClientRect` returns zeros in jsdom), so
 * the actual math is factored out to take numbers a test can construct
 * directly, matching how `Transport` itself takes an injectable `now`/
 * `scheduleFrame` rather than reaching for real timers.
 */
export interface ScrubberPointerPosition {
  /** The track's left edge, in the same coordinate space as `pointerX`. */
  trackLeft: number;
  /** The track's width. Must be positive for a meaningful result. */
  trackWidth: number;
  /** The pointer's x position, in the same coordinate space as `trackLeft`. */
  pointerX: number;
}

/**
 * Maps a pointer x position on a scrubber track to a frame number in
 * `[0, durationInFrames - 1]`.
 *
 * The track's full width represents the closed interval
 * `[0, durationInFrames - 1]` (frame 0 at the track's left edge, the last
 * frame at its right edge), so a pointer at the exact midpoint maps to
 * `(durationInFrames - 1) / 2`, rounded to the nearest integer frame.
 * Positions outside `[trackLeft, trackLeft + trackWidth]` clamp to the
 * nearest end rather than extrapolating past it.
 */
export function pointerPositionToFrame(
  position: ScrubberPointerPosition,
  durationInFrames: number,
): number {
  const { trackLeft, trackWidth, pointerX } = position;
  const lastFrame = Math.max(durationInFrames - 1, 0);

  if (trackWidth <= 0) {
    return 0;
  }

  const fraction = (pointerX - trackLeft) / trackWidth;
  const clampedFraction = Math.min(Math.max(fraction, 0), 1);
  return Math.round(clampedFraction * lastFrame);
}
