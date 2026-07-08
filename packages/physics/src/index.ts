import RAPIER from "@dimforge/rapier3d-compat";

export {
  PhysicsConstraintBodyNotFoundError,
  PhysicsConstraintMissingAxisError,
} from "./errors.js";
export type { Quaternion } from "./euler-quaternion.js";
export { eulerXyzToQuaternion, quaternionToEulerXyz } from "./euler-quaternion.js";
export type { PhysicsBake, PhysicsTransform } from "./physics-bake.js";
export { createPhysicsBake } from "./physics-bake.js";

/**
 * Loads `@dimforge/rapier3d-compat`'s own inlined WebAssembly module. Must
 * be called and awaited exactly once, before `createPhysicsBake` (or
 * anything else in this package) is ever called - mirroring the underlying
 * library's own documented requirement, just renamed so a caller never
 * needs to import `@dimforge/rapier3d-compat` directly.
 */
export const initPhysics: () => Promise<void> = () => RAPIER.init();
