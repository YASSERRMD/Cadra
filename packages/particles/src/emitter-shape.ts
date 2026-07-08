import type { ParticleEmitterShape, Vector3 } from "@cadra/core";

import { particleHash, particleHashSigned } from "./hash.js";

/**
 * Samples a deterministic spawn position for one particle slot, in the
 * `ParticleSystemNode`'s own local space (before its `transform` is
 * applied) - the same local-space-then-transform convention
 * `ColliderConfig`'s own axis-aligned shapes use, oriented by rotating the
 * whole node rather than by an orientation field on the shape itself.
 *
 * `dimensionOffset` lets a caller drawing several independent samples for
 * the same particle at the same frame (e.g. spawn position, then separately
 * initial speed and lifetime jitter) avoid reusing the same hash dimensions;
 * this function consumes dimensions `dimensionOffset` through
 * `dimensionOffset + 2`.
 */
export function sampleEmitterShape(
  shape: ParticleEmitterShape,
  numericSeed: number,
  emitterSeed: number,
  particleIndex: number,
  frame: number,
  dimensionOffset: number,
): Vector3 {
  const hash = (dimension: number) =>
    particleHash(numericSeed, emitterSeed, particleIndex, frame, dimensionOffset + dimension);
  const hashSigned = (dimension: number) =>
    particleHashSigned(numericSeed, emitterSeed, particleIndex, frame, dimensionOffset + dimension);

  switch (shape.type) {
    case "point":
      return [0, 0, 0];

    case "box":
      return [
        hashSigned(0) * shape.halfExtents[0],
        hashSigned(1) * shape.halfExtents[1],
        hashSigned(2) * shape.halfExtents[2],
      ];

    case "sphere": {
      // Uniform-in-volume point inside the sphere: a uniform direction
      // (via the standard inverse-cosine latitude sampling) and a radius
      // scaled by the cube root of a uniform variable, so the sampled
      // points don't bunch up toward the center.
      const theta = hash(0) * Math.PI * 2;
      const phi = Math.acos(hashSigned(1));
      const radius = shape.radius * Math.cbrt(hash(2));
      const sinPhi = Math.sin(phi);
      return [radius * sinPhi * Math.cos(theta), radius * sinPhi * Math.sin(theta), radius * Math.cos(phi)];
    }

    case "cone": {
      // A simple (not volume-corrected) sample within a solid cone: apex at
      // the local origin, axis along local +Y, half-angle `shape.angle`,
      // base radius `shape.radius` at height radius/tan(angle). Good enough
      // for a visually convincing "particles emerge from within this cone"
      // spawn volume; unlike the sphere case above, height and radial
      // fraction are sampled linearly, not corrected for uniform density.
      const height = shape.angle > 0 ? shape.radius / Math.tan(shape.angle) : 0;
      const heightFraction = hash(0);
      const radialFraction = hash(1);
      const theta = hash(2) * Math.PI * 2;
      const y = heightFraction * height;
      const radiusAtHeight = heightFraction * shape.radius * radialFraction;
      return [radiusAtHeight * Math.cos(theta), y, radiusAtHeight * Math.sin(theta)];
    }
  }
}
