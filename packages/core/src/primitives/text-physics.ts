import { smoothNoise } from "../frame/smooth-noise.js";
import { spring } from "../interpolation/spring.js";
import type { TextPhysicsConfig } from "../scene-graph/scene-node.js";

/** One unit's resolved-at-a-frame physics state; only the aspects `TextPhysicsConfig.effect` actually drives are present. `"scramble"`/`"countUp"` are content effects (see `resolveScrambleText`/`resolveCountUpText`), not transform effects, so they always resolve to `{}` here. */
export interface ResolvedGlyphPhysicsState {
  offsetX?: number;
  offsetY?: number;
  rotationZ?: number;
  scale?: number;
  opacity?: number;
}

function resolveSpring(config: TextPhysicsConfig, rank: number, frame: number): ResolvedGlyphPhysicsState {
  const unitStartFrame = (config.startFrame ?? 0) + rank * (config.delayFrames ?? 0);
  const localFrame = Math.max(frame - unitStartFrame, 0);
  const fps = config.fps ?? 30;
  const distance = config.distance ?? 1;

  const progress = spring(localFrame, fps, {
    mass: config.mass ?? 1,
    stiffness: config.stiffness ?? 100,
    damping: config.damping ?? 10,
    from: 0,
    to: 1,
  });

  return {
    offsetY: distance * (progress - 1),
    scale: progress,
    opacity: Math.min(Math.max(progress, 0), 1),
  };
}

function resolveJitter(config: TextPhysicsConfig, rank: number, frame: number): ResolvedGlyphPhysicsState {
  const seed = config.seed ?? 0;
  const positionAmplitude = config.positionAmplitude ?? 0.05;
  const rotationAmplitude = config.rotationAmplitude ?? 0;
  const periodFrames = config.periodFrames ?? 20;

  const offsetX = smoothNoise(`${seed}:${rank}:jitter-x`, frame, periodFrames) * positionAmplitude;
  const offsetY = smoothNoise(`${seed}:${rank}:jitter-y`, frame, periodFrames) * positionAmplitude;

  return {
    offsetX,
    offsetY,
    ...(rotationAmplitude !== 0 && {
      rotationZ: smoothNoise(`${seed}:${rank}:jitter-r`, frame, periodFrames) * rotationAmplitude,
    }),
  };
}

function resolveWave(config: TextPhysicsConfig, rank: number, frame: number): ResolvedGlyphPhysicsState {
  const amplitude = config.positionAmplitude ?? 0.1;
  const periodFrames = config.periodFrames ?? 30;
  const phaseShiftFrames = rank * (config.delayFrames ?? 0);
  const offsetY = amplitude * Math.sin((2 * Math.PI * (frame - phaseShiftFrames)) / periodFrames);
  return { offsetY };
}

/**
 * Resolves one unit's physics state at `frame`, given its own `rank`
 * (`computeStaggerRanks`'s output for its unit index, from
 * `@cadra/text`'s `splitTextUnits` against `config.grouping`) - the one
 * function every transform-affecting `TextPhysicsEffect` funnels through.
 * Pure and stateless: the same `(config, rank, frame)` always resolves to
 * the same state, exactly like `spring`'s and `resolveTextUnitState`'s own
 * re-derive-from-scratch-every-call design, so evaluating frames out of
 * order or repeatedly never drifts.
 *
 * `"scramble"`/`"countUp"` resolve to `{}` here (no transform at all):
 * both are content effects that change *what character a unit displays*,
 * not a transform layered on top of it - see `resolveScrambleText`/
 * `resolveCountUpText`.
 */
export function resolveGlyphPhysicsState(
  config: TextPhysicsConfig,
  rank: number,
  frame: number,
): ResolvedGlyphPhysicsState {
  switch (config.effect) {
    case "spring":
      return resolveSpring(config, rank, frame);
    case "jitter":
      return resolveJitter(config, rank, frame);
    case "wave":
      return resolveWave(config, rank, frame);
    case "scramble":
    case "countUp":
      return {};
  }
}
