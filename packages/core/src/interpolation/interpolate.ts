import { lerp } from "./lerp.js";

/** How to compute output when `frame` falls outside `inputRange`. */
export type ExtrapolateMode = "extend" | "clamp";

export interface InterpolateOptions {
  /**
   * Behavior below `inputRange[0]`. `"extend"` (default) linearly continues
   * the first segment's slope; `"clamp"` holds at `outputRange[0]`.
   */
  extrapolateLeft?: ExtrapolateMode;
  /**
   * Behavior above the last `inputRange` value. `"extend"` (default)
   * linearly continues the last segment's slope; `"clamp"` holds at the
   * last `outputRange` value.
   */
  extrapolateRight?: ExtrapolateMode;
  /**
   * Optional easing curve applied within each segment, re-normalized to
   * that segment's local progress (0 at the segment's start, 1 at its
   * end). Not applied when extrapolating past the range, since there the
   * result is a straight linear continuation of the boundary segment's
   * slope, not a re-run of the eased curve past its natural domain.
   */
  easing?: (t: number) => number;
}

/** Thrown when `inputRange` is not strictly increasing: not a hidden assumption, a real invariant. */
export class NonMonotonicInputRangeError extends Error {
  constructor(public readonly inputRange: readonly number[]) {
    super(
      `interpolate's inputRange must be strictly monotonically increasing, got [${inputRange.join(", ")}].`,
    );
    this.name = "NonMonotonicInputRangeError";
  }
}

/** Thrown when `inputRange` and `outputRange` do not have the same length. */
export class InterpolateRangeLengthMismatchError extends Error {
  constructor(inputLength: number, outputLength: number) {
    super(
      `interpolate's inputRange (length ${inputLength}) and outputRange (length ${outputLength}) must have the same length.`,
    );
    this.name = "InterpolateRangeLengthMismatchError";
  }
}

function assertStrictlyIncreasing(inputRange: readonly number[]): void {
  for (let i = 1; i < inputRange.length; i += 1) {
    const previous = inputRange[i - 1];
    const current = inputRange[i];
    if (previous === undefined || current === undefined || current <= previous) {
      throw new NonMonotonicInputRangeError(inputRange);
    }
  }
}

/**
 * Finds the segment index `i` such that `inputRange[i] <= frame <=
 * inputRange[i + 1]`, for `frame` already known to be within the range
 * (inclusive of both ends). Linear scan: input ranges are expected to be
 * short (a handful of keyframes), so this is simpler and plenty fast rather
 * than a binary search.
 */
function findSegmentIndex(inputRange: readonly number[], frame: number): number {
  for (let i = 0; i < inputRange.length - 1; i += 1) {
    const segmentEnd = inputRange[i + 1];
    if (segmentEnd === undefined || frame <= segmentEnd) {
      return i;
    }
  }
  return inputRange.length - 2;
}

/**
 * Maps `frame` from `inputRange` to `outputRange`, piecewise-linearly
 * interpolating within each segment (with an optional per-segment easing
 * curve) and extrapolating beyond the range according to
 * `options.extrapolateLeft`/`options.extrapolateRight`.
 *
 * `inputRange` must be strictly monotonically increasing; `outputRange` has
 * no such constraint, since plain per-segment linear interpolation math
 * (`lerp`) is agnostic to whether a segment's output increases, decreases,
 * or reverses direction relative to its neighbors (e.g. a fade-out with
 * `outputRange: [1, 0]` is just as valid as a fade-in).
 *
 * @throws {NonMonotonicInputRangeError} if `inputRange` is not strictly increasing.
 * @throws {InterpolateRangeLengthMismatchError} if the two ranges differ in length.
 */
export function interpolate(
  frame: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options: InterpolateOptions = {},
): number {
  if (inputRange.length !== outputRange.length) {
    throw new InterpolateRangeLengthMismatchError(inputRange.length, outputRange.length);
  }
  assertStrictlyIncreasing(inputRange);

  const firstInput = inputRange[0];
  const lastInput = inputRange[inputRange.length - 1];
  const firstOutput = outputRange[0];
  const lastOutput = outputRange[outputRange.length - 1];
  if (
    firstInput === undefined ||
    lastInput === undefined ||
    firstOutput === undefined ||
    lastOutput === undefined
  ) {
    // inputRange/outputRange are same-length arrays (checked above); this
    // only happens for length-0 ranges, which carry no interpolatable data.
    throw new Error("interpolate requires inputRange and outputRange to have at least one entry.");
  }

  const extrapolateLeft = options.extrapolateLeft ?? "extend";
  const extrapolateRight = options.extrapolateRight ?? "extend";

  if (frame < firstInput) {
    if (extrapolateLeft === "clamp") {
      return firstOutput;
    }
    return extendSegment(inputRange, outputRange, 0, frame);
  }

  if (frame > lastInput) {
    if (extrapolateRight === "clamp") {
      return lastOutput;
    }
    return extendSegment(inputRange, outputRange, inputRange.length - 2, frame);
  }

  const segmentIndex = findSegmentIndex(inputRange, frame);
  return interpolateSegment(inputRange, outputRange, segmentIndex, frame, options.easing);
}

/**
 * Linearly extrapolates past the range using the slope of the segment at
 * `segmentIndex` (the first segment for left extrapolation, the last for
 * right extrapolation). Ignores any `easing` option: past the natural
 * domain there is no "segment progress" left to ease, only a straight-line
 * continuation of the boundary slope.
 */
function extendSegment(
  inputRange: readonly number[],
  outputRange: readonly number[],
  segmentIndex: number,
  frame: number,
): number {
  const inputStart = inputRange[segmentIndex];
  const inputEnd = inputRange[segmentIndex + 1];
  const outputStart = outputRange[segmentIndex];
  const outputEnd = outputRange[segmentIndex + 1];
  if (
    inputStart === undefined ||
    inputEnd === undefined ||
    outputStart === undefined ||
    outputEnd === undefined
  ) {
    throw new Error("interpolate: invalid segment index during extrapolation.");
  }

  const t = (frame - inputStart) / (inputEnd - inputStart);
  return lerp(outputStart, outputEnd, t);
}

function interpolateSegment(
  inputRange: readonly number[],
  outputRange: readonly number[],
  segmentIndex: number,
  frame: number,
  easing: ((t: number) => number) | undefined,
): number {
  const inputStart = inputRange[segmentIndex];
  const inputEnd = inputRange[segmentIndex + 1];
  const outputStart = outputRange[segmentIndex];
  const outputEnd = outputRange[segmentIndex + 1];
  if (
    inputStart === undefined ||
    inputEnd === undefined ||
    outputStart === undefined ||
    outputEnd === undefined
  ) {
    throw new Error("interpolate: invalid segment index.");
  }

  // A zero-width segment (duplicate adjacent inputRange values) cannot occur
  // here: assertStrictlyIncreasing already rejected inputEnd === inputStart.
  let t = (frame - inputStart) / (inputEnd - inputStart);
  if (easing !== undefined) {
    t = easing(t);
  }
  return lerp(outputStart, outputEnd, t);
}
