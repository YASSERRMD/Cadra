import { bitXor, float, shiftRight, uint } from "three/tsl";
import type { Node } from "three/webgpu";

/**
 * TSL (GPU compute shader) port of `./hash.ts`'s `particleHash`, for the
 * WebGPU compute path. Mirrors the exact same splitmix32 constants and shift
 * amounts as the CPU version, so both paths draw from the same hash family
 * even though they are separately-executed implementations (a compute
 * shader cannot call a plain JS function) - see `./cpu-simulation.ts`'s own
 * doc for why this package has two separate simulations rather than one
 * shared implementation.
 *
 * Every input is already a `uint`-typed TSL node (a per-emitter uniform for
 * `numericSeed`/`emitterSeed`/`frame`, `instanceIndex` for `particleIndex`);
 * `dimension` is a plain JS number, baked in as a constant at shader-graph
 * construction time (each call site wants one fixed dimension, e.g. "0 for
 * spawn-position x jitter").
 */

const SPLITMIX32_INCREMENT = uint(0x9e3779b9);
const SPLITMIX32_MULTIPLIER_A = uint(0x21f0aaad);
const SPLITMIX32_MULTIPLIER_B = uint(0x735a2d97);
const UINT32_RANGE = 4294967296;

function splitmix32StepTSL(state: Node<"uint">): Node<"uint"> {
  const nextState = state.add(SPLITMIX32_INCREMENT) as Node<"uint">;
  const mixedA = bitXor(nextState, shiftRight(nextState, uint(16))).mul(SPLITMIX32_MULTIPLIER_A) as Node<"uint">;
  const mixedB = bitXor(mixedA, shiftRight(mixedA, uint(15))).mul(SPLITMIX32_MULTIPLIER_B) as Node<"uint">;
  return bitXor(mixedB, shiftRight(mixedB, uint(15))) as Node<"uint">;
}

/**
 * TSL port of `combineHash`: combines any number of `uint` nodes into a
 * single derived `uint` node, via one splitmix32 step per input, each XORed
 * with the running state before mixing. Shared by `particleHashTSL` below
 * and `./tsl-curl-noise.ts`'s own lattice-cell hash, so both draw from
 * exactly the same mixing function.
 */
export function combineHashTSL(values: readonly Node<"uint">[]): Node<"uint"> {
  let state = uint(0) as Node<"uint">;
  for (const value of values) {
    state = splitmix32StepTSL(bitXor(state, value) as Node<"uint">);
  }
  return state;
}

/** `combineHashTSL`, scaled from a `uint` node to a `float` node in the half-open range [0, 1). */
export function hashToUnitFloatTSL(values: readonly Node<"uint">[]): Node<"float"> {
  return float(combineHashTSL(values)).div(UINT32_RANGE) as Node<"float">;
}

/**
 * Derives a deterministic float in the half-open range [0, 1) from a
 * composition-level numeric seed, an emitter-local seed, a particle slot
 * index, the current integer frame, and a `dimension` distinguishing which
 * distinct random quantity this call is for. Exactly mirrors
 * `particleHash`'s own combining order.
 */
export function particleHashTSL(
  numericSeed: Node<"uint">,
  emitterSeed: Node<"uint">,
  particleIndex: Node<"uint">,
  frame: Node<"uint">,
  dimension: number,
): Node<"float"> {
  return hashToUnitFloatTSL([numericSeed, emitterSeed, particleIndex, frame, uint(dimension) as Node<"uint">]);
}

/** `particleHashTSL`, remapped from `[0, 1)` to the symmetric range `[-1, 1)`. */
export function particleHashSignedTSL(
  numericSeed: Node<"uint">,
  emitterSeed: Node<"uint">,
  particleIndex: Node<"uint">,
  frame: Node<"uint">,
  dimension: number,
): Node<"float"> {
  return particleHashTSL(numericSeed, emitterSeed, particleIndex, frame, dimension).mul(2).sub(1) as Node<"float">;
}
