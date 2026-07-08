import type { ParticleColliderConfig } from "@cadra/core";
import { dot, float, length, max, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

const MIN_SPHERE_DISTANCE = 1e-6;

/**
 * TSL port of `./colliders.ts`'s `applyColliders`. Every collider's own
 * parameters (`y`, `center`, `radius`, `bounce`) are static per-emitter
 * config, applied as a plain JS loop over the configured list at shader-
 * graph construction time - only `position`/`velocity` are genuine runtime
 * nodes.
 */
export function applyCollidersTSL(
  colliders: readonly ParticleColliderConfig[] | undefined,
  position: Node<"vec3">,
  velocity: Node<"vec3">,
): { position: Node<"vec3">; velocity: Node<"vec3"> } {
  if (colliders === undefined || colliders.length === 0) {
    return { position, velocity };
  }

  let pos = position;
  let vel = velocity;

  for (const collider of colliders) {
    if (collider.type === "groundPlane") {
      const bounce = collider.bounce ?? 0;
      const isBelowGround = pos.y.lessThan(collider.y);
      const newY = isBelowGround.select(float(collider.y), pos.y) as Node<"float">;
      const shouldReflect = isBelowGround.and(vel.y.lessThan(0));
      const newVelY = shouldReflect.select(vel.y.negate().mul(bounce), vel.y) as Node<"float">;
      pos = vec3(pos.x, newY, pos.z) as Node<"vec3">;
      vel = vec3(vel.x, newVelY, vel.z) as Node<"vec3">;
      continue;
    }

    const bounce = collider.bounce ?? 0;
    const center = vec3(...collider.center) as Node<"vec3">;
    const offset = pos.sub(center) as Node<"vec3">;
    const distance = length(offset) as Node<"float">;
    const isInside = distance.lessThan(collider.radius).and(distance.greaterThan(0));
    const safeDistance = max(distance, float(MIN_SPHERE_DISTANCE)) as Node<"float">;
    const normal = offset.div(safeDistance) as Node<"vec3">;

    const newPos = isInside.select(center.add(normal.mul(collider.radius)), pos) as Node<"vec3">;

    const velocityAlongNormal = dot(vel, normal) as Node<"float">;
    const shouldReflect = isInside.and(velocityAlongNormal.lessThan(0));
    const reflectionScale = velocityAlongNormal.mul(1 + bounce) as Node<"float">;
    const reflectedVel = vel.sub(normal.mul(reflectionScale)) as Node<"vec3">;
    const newVel = shouldReflect.select(reflectedVel, vel) as Node<"vec3">;

    pos = newPos;
    vel = newVel;
  }

  return { position: pos, velocity: vel };
}
