import type { Vector3 } from "@cadra/core";
import { cos, float, max, sin, sqrt, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

import { particleHashTSL } from "./tsl-hash.js";
import { cross, normalizeOrZero } from "./vector-math.js";

/**
 * TSL port of `./direction-jitter.ts`'s `jitterDirection`. `baseDirection`
 * and `spreadAngle` are always static per-emitter config, so the
 * orthonormal basis around `baseDirection` (which depends only on that
 * static config, never on any per-particle value) is computed once in plain
 * JS at shader-graph construction time - only the hash-derived `theta`/`phi`
 * angles within the cone are genuine runtime nodes.
 */
export function jitterDirectionTSL(
  baseDirection: Vector3,
  spreadAngle: number,
  numericSeed: Node<"uint">,
  emitterSeed: Node<"uint">,
  particleIndex: Node<"uint">,
  frame: Node<"uint">,
  dimensionOffset: number,
): Node<"vec3"> {
  const normal = normalizeOrZero(baseDirection);
  const isZero = normal[0] === 0 && normal[1] === 0 && normal[2] === 0;
  if (spreadAngle <= 0 || isZero) {
    return vec3(...normal) as Node<"vec3">;
  }

  const up: Vector3 = Math.abs(normal[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  const tangent = normalizeOrZero(cross(up, normal));
  const bitangent = cross(normal, tangent);

  const hash = (dimension: number) =>
    particleHashTSL(numericSeed, emitterSeed, particleIndex, frame, dimensionOffset + dimension);

  const cosSpread = Math.cos(spreadAngle);
  const cosTheta = float(1).sub(hash(0).mul(1 - cosSpread)) as Node<"float">;
  const sinTheta = sqrt(max(float(0), float(1).sub(cosTheta.mul(cosTheta)))) as Node<"float">;
  const phi = hash(1).mul(Math.PI * 2) as Node<"float">;

  const localX = sinTheta.mul(cos(phi)) as Node<"float">;
  const localY = sinTheta.mul(sin(phi)) as Node<"float">;
  const localZ = cosTheta;

  const tangentTerm = vec3(...tangent).mul(localX) as Node<"vec3">;
  const bitangentTerm = vec3(...bitangent).mul(localY) as Node<"vec3">;
  const normalTerm = vec3(...normal).mul(localZ) as Node<"vec3">;

  return tangentTerm.add(bitangentTerm).add(normalTerm) as Node<"vec3">;
}
