import { interpolateVector3 } from "../interpolation/lerp.js";
import { resolveNumberProperty, resolveVector3Property } from "../keyframes/compile.js";
import type { Vector3 } from "../scene-graph/primitives.js";
import type {
  TextPathAlignment,
  TextPathConfig,
  TextPathOrientation,
  TextPathSegment,
  TextPathSpacing,
} from "../scene-graph/scene-node.js";

/** One `TextPathSegment`, resolved to plain `Vector3`s at a specific frame. */
export type ResolvedTextPathSegment =
  | { type: "line"; to: Vector3 }
  | { type: "quadratic"; control: Vector3; to: Vector3 }
  | { type: "cubic"; control1: Vector3; control2: Vector3; to: Vector3 };

/** A `TextPathConfig`, fully resolved to plain values at a specific frame. */
export interface ResolvedTextPath {
  start: Vector3;
  segments: readonly ResolvedTextPathSegment[];
  progress: number;
  startOffset: number;
  orientation: TextPathOrientation;
  spacing: TextPathSpacing;
  alignment: TextPathAlignment;
}

/** Resolves every `Property<T>` in a `TextPathConfig` (including every segment's own control/end points, so a deforming path is just as frame-dependent as any other animatable field) to its plain value at `frame`. */
export function resolveTextPath(path: TextPathConfig, frame: number): ResolvedTextPath {
  return {
    start: resolveVector3Property(path.start, frame),
    segments: path.segments.map((segment) => resolveTextPathSegment(segment, frame)),
    progress: resolveNumberProperty(path.progress ?? 1, frame),
    startOffset: resolveNumberProperty(path.startOffset ?? 0, frame),
    orientation: path.orientation ?? "tangent",
    spacing: path.spacing ?? "advance",
    alignment: path.alignment ?? "start",
  };
}

function resolveTextPathSegment(segment: TextPathSegment, frame: number): ResolvedTextPathSegment {
  switch (segment.type) {
    case "line":
      return { type: "line", to: resolveVector3Property(segment.to, frame) };
    case "quadratic":
      return {
        type: "quadratic",
        control: resolveVector3Property(segment.control, frame),
        to: resolveVector3Property(segment.to, frame),
      };
    case "cubic":
      return {
        type: "cubic",
        control1: resolveVector3Property(segment.control1, frame),
        control2: resolveVector3Property(segment.control2, frame),
        to: resolveVector3Property(segment.to, frame),
      };
  }
}

/** Evaluates one already-resolved segment at local progress `t` (`0` at `from`, `1` at the segment's own `to`), via De Casteljau's algorithm (repeated `lerp`) rather than the expanded Bernstein-basis polynomial - the same construction, just simpler to verify correct by inspection. */
function evaluateSegment(from: Vector3, segment: ResolvedTextPathSegment, t: number): Vector3 {
  switch (segment.type) {
    case "line":
      return interpolateVector3(t, from, segment.to);
    case "quadratic": {
      const a = interpolateVector3(t, from, segment.control);
      const b = interpolateVector3(t, segment.control, segment.to);
      return interpolateVector3(t, a, b);
    }
    case "cubic": {
      const a = interpolateVector3(t, from, segment.control1);
      const b = interpolateVector3(t, segment.control1, segment.control2);
      const c = interpolateVector3(t, segment.control2, segment.to);
      const ab = interpolateVector3(t, a, b);
      const bc = interpolateVector3(t, b, c);
      return interpolateVector3(t, ab, bc);
    }
  }
}

function vectorSubtract(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vectorLength(v: Vector3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

function vectorNormalize(v: Vector3): Vector3 {
  const length = vectorLength(v);
  return length === 0 ? [0, 0, 0] : [v[0] / length, v[1] / length, v[2] / length];
}

/** One point sampled along a `TextPathSampler`'s own curve. */
export interface TextPathSample {
  point: Vector3;
  /** Normalized direction of travel at this point. `[0, 0, 0]` only for a fully degenerate (zero-length) curve. */
  tangent: Vector3;
}

/** Arc-length-parameterized access into a `ResolvedTextPath`'s own curve. */
export interface TextPathSampler {
  /** The curve's own total length, summed across every segment. `0` for a degenerate path (a single point, or no segments at all). */
  totalLength: number;
  /** Samples the curve at arc-length fraction `u` (`0` at the very start, `1` at the very end), clamping `u` to `[0, 1]`. */
  sampleAt(u: number): TextPathSample;
}

/** How many straight sub-segments each curved (`quadratic`/`cubic`) segment is flattened into for arc-length estimation. A `"line"` segment needs only its own two endpoints (it is already straight), so this only affects curved segments' own precision. */
const SAMPLES_PER_CURVED_SEGMENT = 32;

/**
 * Builds a `TextPathSampler` over `path`'s own sequence of segments: flattens
 * every segment into short straight sub-segments, accumulates their real
 * (Euclidean) lengths into a running total, and answers `sampleAt(u)` by
 * locating which flattened sub-segment `u * totalLength` falls into and
 * linearly interpolating within it - the standard "polyline approximation"
 * technique for arc-length reparameterization of a Bezier curve, exactly
 * what `THREE.Curve.getPointAt`/`getTangentAt` do internally, reimplemented
 * here directly so this stays framework-agnostic (`@cadra/core` has no
 * Three.js dependency) and independently testable.
 */
export function createTextPathSampler(path: ResolvedTextPath): TextPathSampler {
  const points: Vector3[] = [path.start];
  let current = path.start;
  for (const segment of path.segments) {
    const sampleCount = segment.type === "line" ? 1 : SAMPLES_PER_CURVED_SEGMENT;
    for (let i = 1; i <= sampleCount; i += 1) {
      points.push(evaluateSegment(current, segment, i / sampleCount));
    }
    current = segment.to;
  }

  const cumulativeLengths: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1] as Vector3;
    const segmentLength = vectorLength(vectorSubtract(points[i] as Vector3, previous));
    cumulativeLengths.push((cumulativeLengths[i - 1] as number) + segmentLength);
  }
  const totalLength = cumulativeLengths[cumulativeLengths.length - 1] as number;

  function sampleAt(u: number): TextPathSample {
    if (points.length === 1 || totalLength === 0) {
      return { point: points[0] as Vector3, tangent: [0, 0, 0] };
    }
    const clampedU = Math.max(0, Math.min(1, u));
    const targetLength = clampedU * totalLength;

    let low = 0;
    let high = cumulativeLengths.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((cumulativeLengths[mid] as number) < targetLength) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const upperIndex = Math.max(low, 1);
    const lowerIndex = upperIndex - 1;

    const lowerPoint = points[lowerIndex] as Vector3;
    const upperPoint = points[upperIndex] as Vector3;
    const lowerLength = cumulativeLengths[lowerIndex] as number;
    const upperLength = cumulativeLengths[upperIndex] as number;
    const span = upperLength - lowerLength;
    const localT = span === 0 ? 0 : (targetLength - lowerLength) / span;

    return {
      point: interpolateVector3(localT, lowerPoint, upperPoint),
      tangent: vectorNormalize(vectorSubtract(upperPoint, lowerPoint)),
    };
  }

  return { totalLength, sampleAt };
}
