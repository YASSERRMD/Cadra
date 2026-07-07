import { interpolate } from "../interpolation/interpolate.js";
import { resolveEasingFunction } from "../interpolation/named-easing.js";
import type { TextStaggerConfig, TextStaggerDirection } from "../scene-graph/scene-node.js";

/**
 * Computes each unit's own stagger *rank* (0 = starts first) for `unitCount`
 * units, given `direction`. Returns an array indexed by unit index (i.e.
 * `result[unitIndex]` is that unit's rank), since `"centerOut"` cannot be
 * computed per-unit in isolation - it needs every unit's own distance from
 * the middle to assign dense, gap-free ranks.
 *
 * Pure and deterministic: the same `(unitCount, direction)` always produces
 * the same ranks.
 */
export function computeStaggerRanks(unitCount: number, direction: TextStaggerDirection): readonly number[] {
  const unitIndices = Array.from({ length: unitCount }, (_unused, index) => index);

  switch (direction) {
    case "forward":
      return unitIndices;
    case "backward":
      return unitIndices.map((index) => unitCount - 1 - index);
    case "centerOut": {
      const center = (unitCount - 1) / 2;
      const orderedByDistance = [...unitIndices].sort((a, b) => {
        const distanceA = Math.abs(a - center);
        const distanceB = Math.abs(b - center);
        return distanceA !== distanceB ? distanceA - distanceB : a - b;
      });
      const ranks = new Array<number>(unitCount);
      orderedByDistance.forEach((unitIndex, rank) => {
        ranks[unitIndex] = rank;
      });
      return ranks;
    }
  }
}

/** One unit's resolved-at-a-frame stagger state; only the aspects its own `TextStaggerConfig.preset` actually drives are present. */
export interface ResolvedTextUnitState {
  opacity?: number;
  offsetY?: number;
}

/** `"typewriter"`/`"lineReveal"`/`"fadeInUp"` all reveal via the same clamped, eased `[start, start + duration] -> [0, 1]` progress; only how that progress maps onto `ResolvedTextUnitState` differs. */
function resolveRevealProgress(config: TextStaggerConfig, unitStartFrame: number, frame: number): number {
  const easing = resolveEasingFunction(config.easing ?? "linear");
  return interpolate(frame, [unitStartFrame, unitStartFrame + config.durationFrames], [0, 1], {
    easing,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/**
 * Resolves one unit's stagger state at `frame`, given its own `rank`
 * (`computeStaggerRanks`'s output for its unit index) - the one function
 * every `TextStaggerPreset` funnels through. Pure and stateless: the same
 * `(config, rank, frame)` always resolves to the same state, exactly like
 * `spring`'s own re-integrate-from-zero-every-call design, so evaluating
 * frames out of order or repeatedly never drifts.
 */
export function resolveTextUnitState(config: TextStaggerConfig, rank: number, frame: number): ResolvedTextUnitState {
  const unitStartFrame = config.startFrame + rank * config.delayFrames;

  switch (config.preset) {
    case "typewriter":
    case "lineReveal":
      return { opacity: resolveRevealProgress(config, unitStartFrame, frame) };

    case "fadeInUp": {
      const distance = config.distance ?? 0.5;
      const progress = resolveRevealProgress(config, unitStartFrame, frame);
      // `distance * (progress - 1)`, not `-distance * (1 - progress)`: the
      // two are mathematically identical, but the latter produces `-0`
      // (a negative number times positive-zero) once `progress` reaches
      // exactly `1`, which `toEqual`'s `Object.is`-based comparison (and
      // any other caller distinguishing -0 from 0) would see as different
      // from a plain `0`.
      return { opacity: progress, offsetY: distance * (progress - 1) };
    }

    case "wave": {
      const amplitude = config.amplitude ?? 0.1;
      const periodFrames = config.periodFrames ?? 30;
      const localFrame = frame - unitStartFrame;
      const offsetY = localFrame < 0 ? 0 : amplitude * Math.sin((2 * Math.PI * localFrame) / periodFrames);
      return { offsetY };
    }
  }
}
