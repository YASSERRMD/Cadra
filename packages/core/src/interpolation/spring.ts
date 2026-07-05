/**
 * Deterministic, frame-based damped mass-spring-damper animation.
 *
 * `spring` is a pure function of `(frame, fps, config)`: every call
 * re-integrates the physical system from `elapsed = 0` up to the requested
 * elapsed time `t = frame / fps`, using a fixed 1ms integration step
 * independent of `fps`. No `position`/`velocity` state is ever cached or
 * carried between calls, so the result for a given `frame` never depends on
 * which other frames were evaluated before it or in what order, exactly
 * like `createFrameRandom` in `../frame/prng.ts`.
 */

export interface SpringConfig {
  /** Mass of the spring's body. Higher mass reacts more sluggishly. Default `1`. */
  mass?: number;
  /** Spring stiffness (spring constant `k`). Higher stiffness settles faster. Default `100`. */
  stiffness?: number;
  /** Damping coefficient. Higher damping reduces oscillation/overshoot. Default `10`. */
  damping?: number;
  /** Value at `frame <= 0`. Default `0`. */
  from?: number;
  /** Value the spring settles toward as `frame` grows large. Default `1`. */
  to?: number;
}

/** Fixed integration step in seconds (1ms), independent of `fps`. */
const FIXED_STEP_SECONDS = 1 / 1000;

/**
 * Evaluates a damped mass-spring-damper system at `frame` (at `fps` frames
 * per second), settling from `config.from` toward `config.to`.
 *
 * Uses fixed-step (1ms) semi-implicit Euler integration of the spring
 * toward a unit target (`position` runs from 0 to 1), then remaps that
 * normalized `position` into `[config.from, config.to]`. Re-integrates from
 * scratch on every call: see the module doc for why that is what makes this
 * deterministic per frame.
 *
 * If `frame / fps <= 0`, returns `config.from` immediately without
 * integrating (the spring has not started moving yet).
 */
export function spring(frame: number, fps: number, config: SpringConfig = {}): number {
  const mass = config.mass ?? 1;
  const stiffness = config.stiffness ?? 100;
  const damping = config.damping ?? 10;
  const from = config.from ?? 0;
  const to = config.to ?? 1;

  const t = frame / fps;
  if (t <= 0) {
    return from;
  }

  let position = 0;
  let velocity = 0;
  let elapsed = 0;

  while (elapsed < t) {
    const step = Math.min(FIXED_STEP_SECONDS, t - elapsed);
    const acceleration = (-stiffness * (position - 1) - damping * velocity) / mass;
    velocity += acceleration * step;
    position += velocity * step;
    elapsed += step;
  }

  return from + (to - from) * position;
}
