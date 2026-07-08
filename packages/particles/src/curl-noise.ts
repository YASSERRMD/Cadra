import type { Vector3 } from "@cadra/core";

import { hashToUnitFloat } from "./hash.js";

/**
 * Deterministic 3D curl noise (Phase 67), for the `curlNoise` particle
 * force. `@cadra/core` has no spatial noise field of its own (only
 * `frame/smooth-noise.ts`'s time-domain checkpoint-and-lerp wobble, a
 * different problem - see its own doc), so this is a fresh, standard
 * implementation: a divergence-free (in the continuous limit) vector field
 * built as the curl of a 3-channel value-noise vector potential, sampled via
 * central finite differences. Curl noise gives turbulent-looking particle
 * motion with no visible sources or sinks - unlike using raw noise as a
 * velocity directly, particles never all flow toward or away from one
 * point.
 *
 * Animating the field over time (the force config's own optional `speed`)
 * is this module's caller's concern, not this module's: the simulation step
 * (which alone has both the noise config and the elapsed time) offsets one
 * sample coordinate by `speed * elapsedSeconds` before calling `curlNoise3D`,
 * the standard cheap trick for animating a 3D field without needing true 4D
 * noise.
 *
 * `./tsl-curl-noise.ts` ports this exact formula for the GPU compute path.
 */

/** Perlin's improved fade curve, giving value noise a continuous first derivative across lattice-cell boundaries instead of the visible creases a plain linear lerp would leave. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Deterministic hash of one integer lattice-cell corner, remapped to [-1, 1). */
function latticeHash(seed: number, channel: number, ix: number, iy: number, iz: number): number {
  return hashToUnitFloat([seed, channel, ix, iy, iz]) * 2 - 1;
}

/**
 * One scalar channel of a smooth, deterministic pseudo-random field, built
 * by trilinearly interpolating a hashed value at each corner of the unit
 * lattice cell containing `(x, y, z)`. `channel` selects an independent
 * noise field sharing the same `seed` (`curlNoise3D` samples three: one per
 * vector-potential component).
 */
export function valueNoise3D(seed: number, channel: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const tz = fade(z - z0);

  const c000 = latticeHash(seed, channel, x0, y0, z0);
  const c100 = latticeHash(seed, channel, x0 + 1, y0, z0);
  const c010 = latticeHash(seed, channel, x0, y0 + 1, z0);
  const c110 = latticeHash(seed, channel, x0 + 1, y0 + 1, z0);
  const c001 = latticeHash(seed, channel, x0, y0, z0 + 1);
  const c101 = latticeHash(seed, channel, x0 + 1, y0, z0 + 1);
  const c011 = latticeHash(seed, channel, x0, y0 + 1, z0 + 1);
  const c111 = latticeHash(seed, channel, x0 + 1, y0 + 1, z0 + 1);

  const x00 = lerp(c000, c100, tx);
  const x10 = lerp(c010, c110, tx);
  const x01 = lerp(c001, c101, tx);
  const x11 = lerp(c011, c111, tx);

  const y0Interp = lerp(x00, x10, ty);
  const y1Interp = lerp(x01, x11, ty);

  return lerp(y0Interp, y1Interp, tz);
}

/** Finite-difference step used to numerically differentiate the potential field. Small enough to approximate the true derivative closely, large enough to stay well clear of floating-point cancellation. */
const CURL_EPSILON = 1e-3;

/**
 * The curl of a 3-channel value-noise vector potential at `(x, y, z)`,
 * scaled by `frequency` before sampling (higher frequency means smaller,
 * more tightly packed swirls). Computed via six central finite differences
 * (the standard cost of curl noise: each of the curl's three components
 * needs two of the vector potential's off-diagonal partial derivatives).
 */
export function curlNoise3D(seed: number, x: number, y: number, z: number, frequency: number): Vector3 {
  const sx = x * frequency;
  const sy = y * frequency;
  const sz = z * frequency;
  const e = CURL_EPSILON;
  const inverseTwoEpsilon = 1 / (2 * e);

  const dPsiZdy = (valueNoise3D(seed, 2, sx, sy + e, sz) - valueNoise3D(seed, 2, sx, sy - e, sz)) * inverseTwoEpsilon;
  const dPsiYdz = (valueNoise3D(seed, 1, sx, sy, sz + e) - valueNoise3D(seed, 1, sx, sy, sz - e)) * inverseTwoEpsilon;
  const dPsiXdz = (valueNoise3D(seed, 0, sx, sy, sz + e) - valueNoise3D(seed, 0, sx, sy, sz - e)) * inverseTwoEpsilon;
  const dPsiZdx = (valueNoise3D(seed, 2, sx + e, sy, sz) - valueNoise3D(seed, 2, sx - e, sy, sz)) * inverseTwoEpsilon;
  const dPsiYdx = (valueNoise3D(seed, 1, sx + e, sy, sz) - valueNoise3D(seed, 1, sx - e, sy, sz)) * inverseTwoEpsilon;
  const dPsiXdy = (valueNoise3D(seed, 0, sx, sy + e, sz) - valueNoise3D(seed, 0, sx, sy - e, sz)) * inverseTwoEpsilon;

  return [dPsiZdy - dPsiYdz, dPsiXdz - dPsiZdx, dPsiYdx - dPsiXdy];
}
