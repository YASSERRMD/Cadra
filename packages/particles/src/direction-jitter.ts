import type { Vector3 } from "@cadra/core";

import { particleHash } from "./hash.js";
import { cross, normalizeOrZero } from "./vector-math.js";

/**
 * Randomizes a unit direction within a cone of half-angle `spreadAngle`
 * around `baseDirection`, for a spawning particle's own initial velocity
 * direction. Standard technique: sample a point within a spherical cap of
 * half-angle `spreadAngle` around a fixed reference axis (cosine-weighted in
 * `theta`, so the cap fills uniformly rather than bunching at its center),
 * then rotate that sample from the reference axis onto the actual
 * `baseDirection` via an orthonormal basis built around it.
 *
 * `dimensionOffset` reserves hash dimensions `dimensionOffset` through
 * `dimensionOffset + 1` for this call, letting a caller drawing several
 * independent samples for the same particle at the same frame avoid reusing
 * hash dimensions across them.
 */
export function jitterDirection(
  baseDirection: Vector3,
  spreadAngle: number,
  numericSeed: number,
  emitterSeed: number,
  particleIndex: number,
  frame: number,
  dimensionOffset: number,
): Vector3 {
  const normal = normalizeOrZero(baseDirection);
  const isZero = normal[0] === 0 && normal[1] === 0 && normal[2] === 0;
  if (spreadAngle <= 0 || isZero) {
    return normal;
  }

  const up: Vector3 = Math.abs(normal[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
  const tangent = normalizeOrZero(cross(up, normal));
  const bitangent = cross(normal, tangent);

  const hash = (dimension: number) =>
    particleHash(numericSeed, emitterSeed, particleIndex, frame, dimensionOffset + dimension);

  const cosSpread = Math.cos(spreadAngle);
  const cosTheta = 1 - hash(0) * (1 - cosSpread);
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const phi = hash(1) * Math.PI * 2;

  const localX = sinTheta * Math.cos(phi);
  const localY = sinTheta * Math.sin(phi);
  const localZ = cosTheta;

  return [
    tangent[0] * localX + bitangent[0] * localY + normal[0] * localZ,
    tangent[1] * localX + bitangent[1] * localY + normal[1] * localZ,
    tangent[2] * localX + bitangent[2] * localY + normal[2] * localZ,
  ];
}
