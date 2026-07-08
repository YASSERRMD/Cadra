/**
 * Multiplies an integer frame index into a film grain seed, chosen so
 * consecutive frames land at well-spread, visually decorrelated offsets
 * into the noise field instead of the near-repeats a small integer step
 * would produce: the golden ratio conjugate is the classic choice for this
 * exact "space N deterministic samples apart with no visible periodicity"
 * problem (low-discrepancy sequences), and it is irrational, so `frame *
 * FILM_GRAIN_SEED_MULTIPLIER` never repeats exactly for any two distinct
 * integer frame indices representable in a double.
 */
export const FILM_GRAIN_SEED_MULTIPLIER = 0.6180339887498949;

/**
 * A pure, deterministic function of `frame` alone (never `Math.random()` or
 * a wall-clock timer): the same frame index always reproduces the exact same
 * grain seed, while consecutive frames still animate, matching real film
 * stock's own per-frame noise. Shared verbatim by both backends' own film
 * grain implementations (see `buildWebGl2EffectPass`/`applyWebGpuEffect` in
 * `./post-processing-pipeline.ts`), each of which feeds this value into the
 * same `rand(fract(uv + seed))` hash `FilmShader` already uses.
 */
export function computeFilmGrainSeed(frame: number): number {
  return frame * FILM_GRAIN_SEED_MULTIPLIER;
}
