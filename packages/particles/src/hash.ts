/**
 * Deterministic per-particle hashing (Phase 67).
 *
 * A particle's own stochastic behavior (spawn position/velocity jitter,
 * lifetime variance) must be addressable by (seed, particle slot index,
 * frame, dimension) rather than drawn sequentially from one running stream:
 * GPU compute invocations process every particle slot in parallel, with no
 * draw order at all, so `@cadra/core`'s own `createFrameRandom` (a
 * sequential `next()` generator, built for a single evaluation walking
 * forward one draw at a time) is the wrong shape here. This module instead
 * derives each value directly from its inputs via one splitmix32 mixing step
 * per input, Xor-combined - the same well-distributed hash family
 * `@cadra/core`'s `frame/prng.ts` uses for its own per-frame seed (same
 * constants, same shift amounts), so both packages' randomness traces back
 * to the same mixing function even though this module's own multi-input
 * combining logic is independent (see `./tsl-hash.ts` for the GPU-side port
 * of this exact formula).
 */

/**
 * One round of the splitmix32 mixing function, advancing `state` and
 * returning the mixed 32-bit unsigned output for that step. Identical
 * constants and shift amounts to `@cadra/core`'s own `splitmix32Step`.
 */
function splitmix32Step(state: number): number {
  const nextState = (state + 0x9e3779b9) >>> 0;
  let z = nextState;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  z = (z ^ (z >>> 15)) >>> 0;
  return z;
}

/**
 * Combines any number of 32-bit unsigned integers into a single derived
 * 32-bit hash, via one splitmix32 step per input, each XORed with the
 * running state before mixing. A pure function of its inputs: the same
 * inputs always derive the same hash, independent of call order or any
 * other hash derived before or after it.
 *
 * Exported so other deterministic-hashing needs in this package with a
 * different semantic key shape (e.g. `./curl-noise.ts`'s lattice-cell hash,
 * keyed by integer grid coordinates rather than particle index/frame) reuse
 * this exact mixing function instead of a second, independently-drifting
 * copy of it.
 */
export function combineHash(values: readonly number[]): number {
  let state = 0;
  for (const value of values) {
    state = splitmix32Step((state ^ (value >>> 0)) >>> 0);
  }
  return state;
}

/** `combineHash`, scaled from a 32-bit unsigned integer to a float in the half-open range [0, 1). */
export function hashToUnitFloat(values: readonly number[]): number {
  return combineHash(values) / 4294967296;
}

/**
 * Derives a deterministic float in the half-open range [0, 1) from a
 * composition-level numeric seed (`toNumericSeed(frameContext.seed)`), an
 * emitter-local seed (`ParticleSystemNode.seed`, combined with its own `id`
 * upstream), a particle slot index, the current integer frame, and a
 * `dimension` distinguishing which distinct random quantity this call is for
 * (e.g. `0` for spawn-position jitter on x, `1` for y), so drawing several
 * independent-looking values for the same particle at the same frame never
 * reuses the same hash.
 */
export function particleHash(
  numericSeed: number,
  emitterSeed: number,
  particleIndex: number,
  frame: number,
  dimension: number,
): number {
  return hashToUnitFloat([numericSeed, emitterSeed, particleIndex, frame, dimension]);
}

/**
 * `particleHash`, remapped from `[0, 1)` to the symmetric range `[-1, 1)`.
 * Convenient for jitter/variance terms, which are naturally centered on zero
 * (e.g. `base + particleHashSigned(...) * variance`).
 */
export function particleHashSigned(
  numericSeed: number,
  emitterSeed: number,
  particleIndex: number,
  frame: number,
  dimension: number,
): number {
  return particleHash(numericSeed, emitterSeed, particleIndex, frame, dimension) * 2 - 1;
}
