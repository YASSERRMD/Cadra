import type { KeyframeTrack } from "./keyframe-track.js";

/**
 * A single actionable problem found while validating a `KeyframeTrack`.
 *
 * `index` names the offending keyframe's position in `track.keyframes` and
 * `frame` echoes its (possibly invalid) frame value, so a caller can jump
 * straight to the offending keyframe, mirroring the path-scoped diagnostics
 * `@cadra/schema`'s `parseScene` reports (see `packages/schema/src/parse.ts`).
 */
export interface KeyframeValidationDiagnostic {
  /** Index of the offending keyframe within `track.keyframes`. */
  index: number;
  /** The offending keyframe's `frame` value, exactly as authored. */
  frame: number;
  /** Human-readable explanation of what was wrong at this keyframe. */
  message: string;
}

/**
 * Validates a `KeyframeTrack<T>`'s `frame` sequence: every frame must be a
 * non-negative integer, and frames must be strictly increasing across the
 * track (no two keyframes may share a frame, and none may be out of order).
 * This is what "overlapping keyframes" means for this track type: two
 * keyframes claiming the same frame, or claiming frames out of ascending
 * order.
 *
 * Does not throw: like `parseScene`, this collects and returns diagnostics
 * for the caller to act on. Returns an empty array for a valid track (which
 * may still have zero or one keyframes, since there is no pair of frames to
 * compare in either case).
 */
export function validateKeyframeTrack<T>(track: KeyframeTrack<T>): KeyframeValidationDiagnostic[] {
  const diagnostics: KeyframeValidationDiagnostic[] = [];
  let previousFrame: number | undefined;

  track.keyframes.forEach((keyframe, index) => {
    const { frame } = keyframe;

    if (!Number.isInteger(frame)) {
      diagnostics.push({
        index,
        frame,
        message: `Keyframe at index ${index} has a non-integer frame (${frame}). Frames must be whole numbers.`,
      });
    } else if (frame < 0) {
      diagnostics.push({
        index,
        frame,
        message: `Keyframe at index ${index} has a negative frame (${frame}). Frames must be non-negative.`,
      });
    }

    if (previousFrame !== undefined && frame <= previousFrame) {
      diagnostics.push({
        index,
        frame,
        message:
          `Keyframe at index ${index} has frame ${frame}, which does not come strictly after ` +
          `the previous keyframe's frame ${previousFrame}. Keyframes must be in strictly ` +
          "increasing frame order with no duplicates.",
      });
    }

    previousFrame = frame;
  });

  return diagnostics;
}
