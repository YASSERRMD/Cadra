import { float, floor, int, mix, uint } from "three/tsl";
import type { Node } from "three/webgpu";

import { hashToUnitFloatTSL } from "./tsl-hash.js";

/**
 * TSL (GPU compute shader) port of `./curl-noise.ts`. Mirrors its exact
 * formula (same lattice hash, same Perlin fade curve, same six-finite-
 * difference curl) so the WebGPU compute path's turbulence looks like the
 * same family of field as the CPU fallback's, even though the two are
 * separately-executed implementations - see `./cpu-simulation.ts`'s own doc
 * for why this package has two separate simulations rather than one shared
 * one.
 */

/** Perlin's improved fade curve: `t^3 * (t * (t * 6 - 15) + 10)`. */
function fadeTSL(t: Node<"float">): Node<"float"> {
  return t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10)) as Node<"float">;
}

/** Deterministic hash of one integer lattice-cell corner, remapped to [-1, 1). */
function latticeHashTSL(
  seed: Node<"uint">,
  channel: Node<"uint">,
  ix: Node<"int">,
  iy: Node<"int">,
  iz: Node<"int">,
): Node<"float"> {
  const unitFloat = hashToUnitFloatTSL([seed, channel, uint(ix), uint(iy), uint(iz)]);
  return unitFloat.mul(2).sub(1) as Node<"float">;
}

/**
 * One scalar channel of a smooth, deterministic pseudo-random field, at
 * `(x, y, z)`. Mirrors `valueNoise3D`'s own trilinear-interpolation-over-a-
 * hashed-lattice-cell formula exactly.
 */
export function valueNoise3DTSL(
  seed: Node<"uint">,
  channel: Node<"uint">,
  x: Node<"float">,
  y: Node<"float">,
  z: Node<"float">,
): Node<"float"> {
  const x0 = int(floor(x));
  const y0 = int(floor(y));
  const z0 = int(floor(z));
  const x1 = x0.add(int(1)) as Node<"int">;
  const y1 = y0.add(int(1)) as Node<"int">;
  const z1 = z0.add(int(1)) as Node<"int">;

  const tx = fadeTSL(x.sub(float(x0)) as Node<"float">);
  const ty = fadeTSL(y.sub(float(y0)) as Node<"float">);
  const tz = fadeTSL(z.sub(float(z0)) as Node<"float">);

  const c000 = latticeHashTSL(seed, channel, x0, y0, z0);
  const c100 = latticeHashTSL(seed, channel, x1, y0, z0);
  const c010 = latticeHashTSL(seed, channel, x0, y1, z0);
  const c110 = latticeHashTSL(seed, channel, x1, y1, z0);
  const c001 = latticeHashTSL(seed, channel, x0, y0, z1);
  const c101 = latticeHashTSL(seed, channel, x1, y0, z1);
  const c011 = latticeHashTSL(seed, channel, x0, y1, z1);
  const c111 = latticeHashTSL(seed, channel, x1, y1, z1);

  const x00 = mix(c000, c100, tx) as Node<"float">;
  const x10 = mix(c010, c110, tx) as Node<"float">;
  const x01 = mix(c001, c101, tx) as Node<"float">;
  const x11 = mix(c011, c111, tx) as Node<"float">;

  const y0Interp = mix(x00, x10, ty) as Node<"float">;
  const y1Interp = mix(x01, x11, ty) as Node<"float">;

  return mix(y0Interp, y1Interp, tz) as Node<"float">;
}

const CURL_EPSILON = 1e-3;
const INVERSE_TWO_EPSILON = 1 / (2 * CURL_EPSILON);
const CHANNEL_X = uint(0);
const CHANNEL_Y = uint(1);
const CHANNEL_Z = uint(2);

/**
 * The curl of a 3-channel value-noise vector potential at `(x, y, z)`,
 * scaled by `frequency` before sampling. Mirrors `curlNoise3D`'s own six-
 * central-finite-difference formula exactly. Returns the three components
 * as a plain object rather than a TSL `vec3` node, since the caller
 * (`./gpu-particle-system.ts`) combines each component with a different
 * per-axis force term rather than treating it as an opaque vector.
 */
export function curlNoise3DTSL(
  seed: Node<"uint">,
  x: Node<"float">,
  y: Node<"float">,
  z: Node<"float">,
  frequency: Node<"float">,
): { x: Node<"float">; y: Node<"float">; z: Node<"float"> } {
  const sx = x.mul(frequency) as Node<"float">;
  const sy = y.mul(frequency) as Node<"float">;
  const sz = z.mul(frequency) as Node<"float">;
  const e = float(CURL_EPSILON);

  const dPsiZdy = valueNoise3DTSL(seed, CHANNEL_Z, sx, sy.add(e) as Node<"float">, sz)
    .sub(valueNoise3DTSL(seed, CHANNEL_Z, sx, sy.sub(e) as Node<"float">, sz))
    .mul(INVERSE_TWO_EPSILON) as Node<"float">;
  const dPsiYdz = valueNoise3DTSL(seed, CHANNEL_Y, sx, sy, sz.add(e) as Node<"float">)
    .sub(valueNoise3DTSL(seed, CHANNEL_Y, sx, sy, sz.sub(e) as Node<"float">))
    .mul(INVERSE_TWO_EPSILON) as Node<"float">;
  const dPsiXdz = valueNoise3DTSL(seed, CHANNEL_X, sx, sy, sz.add(e) as Node<"float">)
    .sub(valueNoise3DTSL(seed, CHANNEL_X, sx, sy, sz.sub(e) as Node<"float">))
    .mul(INVERSE_TWO_EPSILON) as Node<"float">;
  const dPsiZdx = valueNoise3DTSL(seed, CHANNEL_Z, sx.add(e) as Node<"float">, sy, sz)
    .sub(valueNoise3DTSL(seed, CHANNEL_Z, sx.sub(e) as Node<"float">, sy, sz))
    .mul(INVERSE_TWO_EPSILON) as Node<"float">;
  const dPsiYdx = valueNoise3DTSL(seed, CHANNEL_Y, sx.add(e) as Node<"float">, sy, sz)
    .sub(valueNoise3DTSL(seed, CHANNEL_Y, sx.sub(e) as Node<"float">, sy, sz))
    .mul(INVERSE_TWO_EPSILON) as Node<"float">;
  const dPsiXdy = valueNoise3DTSL(seed, CHANNEL_X, sx, sy.add(e) as Node<"float">, sz)
    .sub(valueNoise3DTSL(seed, CHANNEL_X, sx, sy.sub(e) as Node<"float">, sz))
    .mul(INVERSE_TWO_EPSILON) as Node<"float">;

  return {
    x: dPsiZdy.sub(dPsiYdz) as Node<"float">,
    y: dPsiXdz.sub(dPsiZdx) as Node<"float">,
    z: dPsiYdx.sub(dPsiXdy) as Node<"float">,
  };
}
