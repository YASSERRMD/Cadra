import type { ColorRGBA, ParticleColorStop, ParticleSizeStop } from "@cadra/core";

/**
 * Evaluating a `colorOverLife`/`sizeOverLife` gradient at a particle's own
 * normalized lifetime (Phase 67). Deliberately separate from `@cadra/core`'s
 * keyframe/`Property<T>` system: that system interpolates over the
 * composition's own integer frame timeline, while a particle's color/size
 * curve interpolates over its own per-particle lifetime fraction (0 at
 * spawn, 1 at expiry) - a different domain the shared frame-based machinery
 * doesn't fit, which is also why `ParticleColorStop`/`ParticleSizeStop` are
 * plain structural data, not `Property<T>`.
 */

/** Color applied for the whole lifetime when a particle node's own `colorOverLife` is omitted: opaque white. */
export const DEFAULT_PARTICLE_COLOR: ColorRGBA = [1, 1, 1, 1];

/** Size multiplier applied for the whole lifetime when a particle node's own `sizeOverLife` is omitted. */
export const DEFAULT_PARTICLE_SIZE_MULTIPLIER = 1;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Finds the two stops (by index into `sortedTimes`) bracketing `t`, and the
 * local interpolation fraction between them. `t` is assumed already clamped
 * to `[sortedTimes[0], sortedTimes[last]]` and `sortedTimes` already sorted
 * ascending with at least 2 entries, so the loop always finds a bracket and
 * `localT` always resolves within `[0, 1]`.
 */
function findBracket(sortedTimes: readonly number[], t: number): { startIndex: number; localT: number } {
  for (let i = 0; i < sortedTimes.length - 1; i += 1) {
    // Safe: i ranges over [0, sortedTimes.length - 2], so both indices are in bounds.
    const start = sortedTimes[i] as number;
    const end = sortedTimes[i + 1] as number;
    if (t <= end) {
      const span = end - start;
      return { startIndex: i, localT: span === 0 ? 0 : (t - start) / span };
    }
  }
  return { startIndex: sortedTimes.length - 2, localT: 1 };
}

/** Shared bracket-and-interpolate evaluator for a sorted-by-`time` stop list, given a per-value-type `lerpValue`. */
function resolveStops<Stop extends { time: number }, Value>(
  stops: readonly Stop[] | undefined,
  t: number,
  defaultValue: Value,
  valueOf: (stop: Stop) => Value,
  lerpValue: (start: Value, end: Value, localT: number) => Value,
): Value {
  if (stops === undefined || stops.length === 0) {
    return defaultValue;
  }
  const firstStop = stops[0] as Stop;
  if (stops.length === 1) {
    return valueOf(firstStop);
  }

  const sorted = [...stops].sort((a, b) => a.time - b.time);
  const firstSorted = sorted[0] as Stop;
  const lastSorted = sorted[sorted.length - 1] as Stop;
  const clampedT = Math.min(lastSorted.time, Math.max(firstSorted.time, t));
  const { startIndex, localT } = findBracket(
    sorted.map((stop) => stop.time),
    clampedT,
  );

  return lerpValue(valueOf(sorted[startIndex] as Stop), valueOf(sorted[startIndex + 1] as Stop), localT);
}

/**
 * Evaluates a particle's `colorOverLife` gradient at normalized lifetime `t`
 * (0 at spawn, 1 at expiry). An empty or omitted `stops` resolves to
 * `DEFAULT_PARTICLE_COLOR` for the whole lifetime; a single stop resolves to
 * that stop's own color for the whole lifetime; `t` outside the outermost
 * stops clamps to the nearest one.
 */
export function resolveColorOverLife(stops: readonly ParticleColorStop[] | undefined, t: number): ColorRGBA {
  return resolveStops(
    stops,
    t,
    DEFAULT_PARTICLE_COLOR,
    (stop) => stop.color,
    (start, end, localT) => [
      lerp(start[0], end[0], localT),
      lerp(start[1], end[1], localT),
      lerp(start[2], end[2], localT),
      lerp(start[3], end[3], localT),
    ],
  );
}

/**
 * Evaluates a particle's `sizeOverLife` curve at normalized lifetime `t` (0
 * at spawn, 1 at expiry). An empty or omitted `stops` resolves to
 * `DEFAULT_PARTICLE_SIZE_MULTIPLIER` for the whole lifetime; a single stop
 * resolves to that stop's own size for the whole lifetime; `t` outside the
 * outermost stops clamps to the nearest one.
 */
export function resolveSizeOverLife(stops: readonly ParticleSizeStop[] | undefined, t: number): number {
  return resolveStops(
    stops,
    t,
    DEFAULT_PARTICLE_SIZE_MULTIPLIER,
    (stop) => stop.size,
    lerp,
  );
}
