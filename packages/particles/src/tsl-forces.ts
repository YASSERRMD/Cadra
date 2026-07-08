import type { ParticleForceConfig } from "@cadra/core";
import { cross, dot, float, length, max, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

import { curlNoise3DTSL } from "./tsl-curl-noise.js";
import { normalizeOrZero } from "./vector-math.js";

const MIN_RADIAL_LENGTH = 1e-6;

/**
 * The tangential acceleration a `vortex` force applies at `position`.
 * `origin`/`axis`/`strength` are static config, so `axisDirection`
 * (normalized once) is computed in plain JS; only the position-dependent
 * radial direction is a genuine runtime node. Mirrors `vortexAcceleration`
 * in `./forces.ts` exactly.
 */
function vortexAccelerationTSL(
  origin: readonly [number, number, number],
  axis: readonly [number, number, number],
  strength: number,
  position: Node<"vec3">,
): Node<"vec3"> {
  const axisDirection = normalizeOrZero([axis[0], axis[1], axis[2]]);
  const axisNode = vec3(...axisDirection) as Node<"vec3">;
  const toPoint = position.sub(vec3(...origin)) as Node<"vec3">;
  const alongAxis = dot(toPoint, axisNode) as Node<"float">;
  const radial = toPoint.sub(axisNode.mul(alongAxis)) as Node<"vec3">;
  const radialLength = max(length(radial) as Node<"float">, float(MIN_RADIAL_LENGTH)) as Node<"float">;
  const radialDirection = radial.div(radialLength) as Node<"vec3">;
  const tangent = cross(axisNode, radialDirection) as Node<"vec3">;
  return tangent.mul(strength) as Node<"vec3">;
}

/**
 * TSL port of `./forces.ts`'s `computeAcceleration`. Every force's own
 * parameters (`acceleration`, `coefficient`, `strength`, `frequency`,
 * `origin`, `axis`) are static per-emitter config, summed as a plain JS loop
 * at shader-graph construction time - only `position`/`velocity` (read from
 * a particle's own storage-buffer slots) and `elapsedSeconds` are genuine
 * runtime nodes.
 */
export function computeAccelerationTSL(
  forces: readonly ParticleForceConfig[] | undefined,
  position: Node<"vec3">,
  velocity: Node<"vec3">,
  curlSeed: Node<"uint">,
  elapsedSeconds: Node<"float">,
): Node<"vec3"> {
  if (forces === undefined || forces.length === 0) {
    return vec3(0, 0, 0) as Node<"vec3">;
  }

  let acceleration = vec3(0, 0, 0) as Node<"vec3">;

  for (const force of forces) {
    switch (force.type) {
      case "gravity": {
        acceleration = acceleration.add(vec3(...force.acceleration)) as Node<"vec3">;
        break;
      }
      case "drag": {
        acceleration = acceleration.sub(velocity.mul(force.coefficient)) as Node<"vec3">;
        break;
      }
      case "curlNoise": {
        const sampleZ =
          force.speed !== undefined && force.speed !== 0
            ? (position.z.add(elapsedSeconds.mul(force.speed)) as Node<"float">)
            : (position.z as Node<"float">);
        const curl = curlNoise3DTSL(curlSeed, position.x, position.y, sampleZ, float(force.frequency));
        const curlVector = vec3(curl.x, curl.y, curl.z) as Node<"vec3">;
        acceleration = acceleration.add(curlVector.mul(force.strength)) as Node<"vec3">;
        break;
      }
      case "vortex": {
        const vortex = vortexAccelerationTSL(force.origin, force.axis, force.strength, position);
        acceleration = acceleration.add(vortex) as Node<"vec3">;
        break;
      }
    }
  }

  return acceleration;
}
