import type { ParticleColliderConfig, Vector3 } from "@cadra/core";

/**
 * Applies simple collision response against every configured collider to a
 * particle's own already-integrated position and velocity for this step.
 * Each collider is tested independently and resolved immediately, in list
 * order - not a physically exact simultaneous-contact solve, mirroring
 * `@cadra/physics`'s own scope: a simple analytic collider is a deliberate
 * simplification for stylized particle motion, not a full rigid-body
 * contact solver.
 */
export function applyColliders(
  colliders: readonly ParticleColliderConfig[] | undefined,
  position: Vector3,
  velocity: Vector3,
): { position: Vector3; velocity: Vector3 } {
  if (colliders === undefined || colliders.length === 0) {
    return { position, velocity };
  }

  let px = position[0];
  let py = position[1];
  let pz = position[2];
  let vx = velocity[0];
  let vy = velocity[1];
  let vz = velocity[2];

  for (const collider of colliders) {
    if (collider.type === "groundPlane") {
      if (py < collider.y) {
        py = collider.y;
        if (vy < 0) {
          vy = -vy * (collider.bounce ?? 0);
        }
      }
      continue;
    }

    const dx = px - collider.center[0];
    const dy = py - collider.center[1];
    const dz = pz - collider.center[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance === 0 || distance >= collider.radius) {
      continue;
    }

    const nx = dx / distance;
    const ny = dy / distance;
    const nz = dz / distance;
    px = collider.center[0] + nx * collider.radius;
    py = collider.center[1] + ny * collider.radius;
    pz = collider.center[2] + nz * collider.radius;

    const velocityAlongNormal = vx * nx + vy * ny + vz * nz;
    if (velocityAlongNormal < 0) {
      const reflectionScale = (1 + (collider.bounce ?? 0)) * velocityAlongNormal;
      vx -= reflectionScale * nx;
      vy -= reflectionScale * ny;
      vz -= reflectionScale * nz;
    }
  }

  return { position: [px, py, pz], velocity: [vx, vy, vz] };
}
