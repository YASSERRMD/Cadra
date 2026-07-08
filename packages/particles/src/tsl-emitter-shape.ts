import type { ParticleEmitterShape } from "@cadra/core";
import { acos, cos, float, pow, sin, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

import { particleHashSignedTSL, particleHashTSL } from "./tsl-hash.js";

/**
 * TSL port of `./emitter-shape.ts`'s `sampleEmitterShape`. `shape` is always
 * static per-emitter config (known at shader-graph construction time), so
 * the shape-kind branch is a plain JS `switch` at construction time, not a
 * runtime GPU branch - only the hash-derived jitter is a genuine node.
 */
export function sampleEmitterShapeTSL(
  shape: ParticleEmitterShape,
  numericSeed: Node<"uint">,
  emitterSeed: Node<"uint">,
  particleIndex: Node<"uint">,
  frame: Node<"uint">,
  dimensionOffset: number,
): Node<"vec3"> {
  const hash = (dimension: number) =>
    particleHashTSL(numericSeed, emitterSeed, particleIndex, frame, dimensionOffset + dimension);
  const hashSigned = (dimension: number) =>
    particleHashSignedTSL(numericSeed, emitterSeed, particleIndex, frame, dimensionOffset + dimension);

  switch (shape.type) {
    case "point":
      return vec3(0, 0, 0) as Node<"vec3">;

    case "box":
      return vec3(
        hashSigned(0).mul(shape.halfExtents[0]),
        hashSigned(1).mul(shape.halfExtents[1]),
        hashSigned(2).mul(shape.halfExtents[2]),
      ) as Node<"vec3">;

    case "sphere": {
      const theta = hash(0).mul(Math.PI * 2) as Node<"float">;
      const phi = acos(hashSigned(1)) as Node<"float">;
      const radius = pow(hash(2), float(1 / 3)).mul(shape.radius) as Node<"float">;
      const sinPhi = sin(phi) as Node<"float">;
      return vec3(
        sinPhi.mul(cos(theta)).mul(radius),
        sinPhi.mul(sin(theta)).mul(radius),
        cos(phi).mul(radius),
      ) as Node<"vec3">;
    }

    case "cone": {
      const height = shape.angle > 0 ? shape.radius / Math.tan(shape.angle) : 0;
      const heightFraction = hash(0);
      const radialFraction = hash(1);
      const theta = hash(2).mul(Math.PI * 2) as Node<"float">;
      const y = heightFraction.mul(height) as Node<"float">;
      const radiusAtHeight = heightFraction.mul(shape.radius).mul(radialFraction) as Node<"float">;
      return vec3(radiusAtHeight.mul(cos(theta)), y, radiusAtHeight.mul(sin(theta))) as Node<"vec3">;
    }
  }
}
