/**
 * Deterministic, per-frame seeded randomness.
 *
 * Rendering must be reproducible frame-by-frame: re-evaluating frame 500 in
 * isolation has to produce the exact same random sequence as evaluating
 * frames 0 through 999 in order and inspecting frame 500. That rules out a
 * single long-lived generator advanced once per frame, because the value you
 * get for frame 500 would then depend on how many frames were drawn from
 * before it (evaluation order), not on frame 500 alone.
 *
 * Instead, every frame gets its own PRNG, freshly seeded by deterministically
 * combining the base `seed` with that frame's integer index. The generator's
 * internal state is never shared or carried across frames; only the derived
 * per-frame seed and the pure step function determine its output.
 *
 * This is a separate concern from `createIdGenerator` in
 * `../scene-graph/id-generator.ts`, which seeds a single long-lived stream
 * used once, at authoring time, to mint stable node ids. This module seeds a
 * fresh stream per frame, used during frame evaluation and rendering.
 */

/**
 * Hashes a string seed down to a 32-bit unsigned integer using the classic
 * djb2 algorithm, mirroring the string-seed handling in `createIdGenerator`.
 * Only used to turn an arbitrary string seed into a numeric seed; not
 * intended as a general-purpose hash.
 */
function hashStringSeed(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    // hash * 33 ^ charCode, kept within 32-bit unsigned range.
    hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Normalizes a `string | number` seed to a 32-bit unsigned integer.
 *
 * Exported so other deterministic subsystems (e.g. `@cadra/particles`'s GPU
 * hash, Phase 67) can turn a composition's `string | number` seed into a
 * single number once, on the CPU, and pass that number on as the base for
 * their own derived hashing (a TSL/GLSL compute shader has no use for a
 * `string`, only for the numeric seed it normalizes to).
 */
export function toNumericSeed(seed: string | number): number {
  return typeof seed === "string" ? hashStringSeed(seed) : seed >>> 0;
}

/**
 * One round of the splitmix32 mixing function, advancing `state` and
 * returning the mixed 32-bit unsigned output for that step. splitmix32 is a
 * small, fast, well-distributed generator: the same input state always
 * produces the same output, with no hidden dependency on prior calls beyond
 * the state value itself.
 */
function splitmix32Step(state: number): { nextState: number; output: number } {
  const nextState = (state + 0x9e3779b9) >>> 0;
  let z = nextState;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  return { nextState, output: z };
}

/**
 * Combines a base numeric seed with an integer frame index into a single
 * derived 32-bit seed, using one splitmix32 step on the base seed followed by
 * one on the frame index. Because this is a pure function of `(seed, frame)`
 * with no external state, the same pair always derives the same seed,
 * regardless of what other frames were evaluated before it or in what order.
 */
function deriveFrameSeed(seed: number, frame: number): number {
  const seeded = splitmix32Step(seed >>> 0);
  const combined = splitmix32Step((seeded.output ^ (frame >>> 0)) >>> 0);
  return combined.output;
}

/**
 * A deterministic pseudo-random number generator, drawn from repeatedly via
 * `next()`. Each call advances the generator's internal state and returns
 * the next float in the half-open range [0, 1).
 */
export interface FrameRandom {
  /** Returns the next float in [0, 1) and advances internal state. */
  next: () => number;
}

/**
 * Creates a `FrameRandom` whose entire output sequence is a pure function of
 * `(seed, frame)`. Two generators created with the same `seed` and `frame`
 * produce the exact same sequence of values when `next()` is called the same
 * number of times, in order, no matter what other `(seed, frame)` pairs were
 * used to create other generators before or after, and no matter whether
 * this frame is evaluated alone or as part of a full render.
 *
 * @param seed - The base seed for the whole render (string or number).
 * @param frame - The integer frame index this generator's sequence belongs
 *   to.
 */
export function createFrameRandom(seed: string | number, frame: number): FrameRandom {
  let state = deriveFrameSeed(toNumericSeed(seed), frame);

  return {
    next(): number {
      const step = splitmix32Step(state);
      state = step.nextState;
      return step.output / 4294967296;
    },
  };
}
