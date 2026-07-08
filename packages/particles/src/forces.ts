import type { ParticleForceConfig, Vector3 } from "@cadra/core";

import { curlNoise3D } from "./curl-noise.js";
import { cross, dot, normalizeOrZero, subtract } from "./vector-math.js";

/**
 * The tangential acceleration a `vortex` force applies at `position`: a
 * constant-magnitude push around `axis` through `origin`, direction given by
 * `axis x radialDirection` (perpendicular to both the swirl axis and the
 * particle's own radial offset from it). Zero exactly on the axis itself,
 * where no radial direction is defined.
 */
function vortexAcceleration(origin: Vector3, axis: Vector3, strength: number, position: Vector3): Vector3 {
  const axisDirection = normalizeOrZero(axis);
  const toPoint = subtract(position, origin);
  const alongAxis = dot(toPoint, axisDirection);
  const radial: Vector3 = [
    toPoint[0] - axisDirection[0] * alongAxis,
    toPoint[1] - axisDirection[1] * alongAxis,
    toPoint[2] - axisDirection[2] * alongAxis,
  ];
  const radialDirection = normalizeOrZero(radial);
  const tangent = cross(axisDirection, radialDirection);
  return [tangent[0] * strength, tangent[1] * strength, tangent[2] * strength];
}

/**
 * Sums every configured force's contribution to a particle's own
 * acceleration, at its current `position` and `velocity`, in world space.
 *
 * `curlNoise` samples the field at `position`, offset along z by
 * `speed * elapsedSeconds` (see `./curl-noise.ts`'s own doc for why this
 * module, not the noise field itself, is responsible for animating it over
 * time), using `numericSeed`/`emitterSeed` (not the particle's own index):
 * every particle passing through the same point in space feels the same
 * flow, which is the whole point of a coherent curl-noise field.
 */
export function computeAcceleration(
  forces: readonly ParticleForceConfig[] | undefined,
  position: Vector3,
  velocity: Vector3,
  numericSeed: number,
  emitterSeed: number,
  elapsedSeconds: number,
): Vector3 {
  if (forces === undefined || forces.length === 0) {
    return [0, 0, 0];
  }

  let ax = 0;
  let ay = 0;
  let az = 0;

  for (const force of forces) {
    switch (force.type) {
      case "gravity": {
        ax += force.acceleration[0];
        ay += force.acceleration[1];
        az += force.acceleration[2];
        break;
      }
      case "drag": {
        ax -= velocity[0] * force.coefficient;
        ay -= velocity[1] * force.coefficient;
        az -= velocity[2] * force.coefficient;
        break;
      }
      case "curlNoise": {
        const sampleZ = position[2] + (force.speed ?? 0) * elapsedSeconds;
        const curlSeed = (numericSeed ^ emitterSeed) >>> 0;
        const curl = curlNoise3D(curlSeed, position[0], position[1], sampleZ, force.frequency);
        ax += curl[0] * force.strength;
        ay += curl[1] * force.strength;
        az += curl[2] * force.strength;
        break;
      }
      case "vortex": {
        const vortex = vortexAcceleration(force.origin, force.axis, force.strength, position);
        ax += vortex[0];
        ay += vortex[1];
        az += vortex[2];
        break;
      }
    }
  }

  return [ax, ay, az];
}
