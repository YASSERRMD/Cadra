import type { PhysicsConstraintConfig } from "@cadra/core";

/** Thrown when a `PhysicsConstraintConfig`'s `bodyA`/`bodyB` does not name a `MeshNode` with `rigidBody` set anywhere in the composition's own scene graph. */
export class PhysicsConstraintBodyNotFoundError extends Error {
  constructor(constraint: PhysicsConstraintConfig, missing: "bodyA" | "bodyB") {
    super(
      `Physics constraint "${constraint.id}" references ${missing} "${constraint[missing]}", which is not a ` +
        "MeshNode with rigidBody set anywhere in this composition. Check the id against the scene graph, or " +
        "add a rigidBody to that node.",
    );
    this.name = "PhysicsConstraintBodyNotFoundError";
  }
}

/** Thrown when a `"revolute"` or `"prismatic"` `PhysicsConstraintConfig` omits its own required `axis`. */
export class PhysicsConstraintMissingAxisError extends Error {
  constructor(constraint: PhysicsConstraintConfig) {
    super(
      `Physics constraint "${constraint.id}" is of type "${constraint.type}", which requires an axis, but none ` +
        "was given.",
    );
    this.name = "PhysicsConstraintMissingAxisError";
  }
}
