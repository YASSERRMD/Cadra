import type {
  ColliderConfig,
  CompositionPhysics,
  MeshNode,
  PhysicsConstraintConfig,
  RigidBodyConfig,
  SceneNode,
  Vector3,
} from "@cadra/core";
import { resolveVector3Property } from "@cadra/core";
import RAPIER from "@dimforge/rapier3d-compat";

import { PhysicsConstraintBodyNotFoundError, PhysicsConstraintMissingAxisError } from "./errors.js";
import { eulerXyzToQuaternion, quaternionToEulerXyz } from "./euler-quaternion.js";

/** A physics-driven mesh node's own resolved pose for one frame, in `AnimatableTransform`'s own Euler-angle convention. */
export interface PhysicsTransform {
  position: Vector3;
  rotation: Vector3;
}

/** Earth gravity, Y-up: `CompositionPhysics.gravity`'s own default. */
const DEFAULT_GRAVITY: Vector3 = [0, -9.81, 0];
/** `CompositionPhysics.substeps`'s own default: one physics step per rendered frame. */
const DEFAULT_SUBSTEPS = 1;

/** `CompositionPhysics`, fully resolved: every field defaulted. */
function resolveCompositionPhysics(config: CompositionPhysics | undefined): { gravity: Vector3; substeps: number } {
  return {
    gravity: config?.gravity ?? DEFAULT_GRAVITY,
    substeps: config?.substeps ?? DEFAULT_SUBSTEPS,
  };
}

/** Recursively collects every `MeshNode` with `rigidBody` set, from a scene-node forest (a composition's own resolved layer roots). */
function collectPhysicsMeshNodes(roots: SceneNode[]): Array<MeshNode & { rigidBody: RigidBodyConfig }> {
  const found: Array<MeshNode & { rigidBody: RigidBodyConfig }> = [];

  function walk(node: SceneNode): void {
    if (node.kind === "mesh" && node.rigidBody !== undefined) {
      found.push(node as MeshNode & { rigidBody: RigidBodyConfig });
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  for (const root of roots) {
    walk(root);
  }
  return found;
}

function buildColliderDesc(collider: ColliderConfig): RAPIER.ColliderDesc {
  switch (collider.shape) {
    case "box": {
      const [hx, hy, hz] = collider.halfExtents;
      return RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    }
    case "sphere":
      return RAPIER.ColliderDesc.ball(collider.radius);
    case "capsule":
      return RAPIER.ColliderDesc.capsule(collider.halfHeight, collider.radius);
    case "cylinder":
      return RAPIER.ColliderDesc.cylinder(collider.halfHeight, collider.radius);
  }
}

function buildRigidBodyDesc(rigidBody: RigidBodyConfig, position: Vector3, rotation: Vector3): RAPIER.RigidBodyDesc {
  const desc =
    rigidBody.bodyType === "dynamic"
      ? RAPIER.RigidBodyDesc.dynamic()
      : rigidBody.bodyType === "kinematic"
        ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.fixed();

  desc.setTranslation(position[0], position[1], position[2]);
  desc.setRotation(eulerXyzToQuaternion(rotation));

  // Velocity/damping/CCD are only ever read by Rapier for a dynamic body
  // (RigidBodyConfig's own doc: ignored for "fixed"/"kinematic"), so there
  // is no need to guard setting them behind a bodyType check here too.
  if (rigidBody.initialLinearVelocity !== undefined) {
    const [x, y, z] = rigidBody.initialLinearVelocity;
    desc.setLinvel(x, y, z);
  }
  if (rigidBody.initialAngularVelocity !== undefined) {
    const [x, y, z] = rigidBody.initialAngularVelocity;
    desc.setAngvel({ x, y, z });
  }
  if (rigidBody.linearDamping !== undefined) {
    desc.setLinearDamping(rigidBody.linearDamping);
  }
  if (rigidBody.angularDamping !== undefined) {
    desc.setAngularDamping(rigidBody.angularDamping);
  }
  if (rigidBody.ccdEnabled !== undefined) {
    desc.setCcdEnabled(rigidBody.ccdEnabled);
  }

  return desc;
}

function buildColliderDescWithMaterial(rigidBody: RigidBodyConfig): RAPIER.ColliderDesc {
  const desc = buildColliderDesc(rigidBody.collider);
  if (rigidBody.friction !== undefined) {
    desc.setFriction(rigidBody.friction);
  }
  if (rigidBody.restitution !== undefined) {
    desc.setRestitution(rigidBody.restitution);
  }
  if (rigidBody.mass !== undefined) {
    desc.setMass(rigidBody.mass);
  }
  return desc;
}

function toRapierVector(v: Vector3): RAPIER.Vector {
  return { x: v[0], y: v[1], z: v[2] };
}

/** The identity rotation, for `JointData.fixed`'s own per-body anchor-frame arguments - `PhysicsConstraintConfig` has no per-body anchor orientation of its own, only anchor points. */
const IDENTITY_ROTATION: RAPIER.Rotation = { x: 0, y: 0, z: 0, w: 1 };

function buildJointData(constraint: PhysicsConstraintConfig): RAPIER.JointData {
  const anchorA = toRapierVector(constraint.anchorA);
  const anchorB = toRapierVector(constraint.anchorB);

  switch (constraint.type) {
    case "fixed":
      return RAPIER.JointData.fixed(anchorA, IDENTITY_ROTATION, anchorB, IDENTITY_ROTATION);
    case "spherical":
      return RAPIER.JointData.spherical(anchorA, anchorB);
    case "revolute":
      if (constraint.axis === undefined) {
        throw new PhysicsConstraintMissingAxisError(constraint);
      }
      return RAPIER.JointData.revolute(anchorA, anchorB, toRapierVector(constraint.axis));
    case "prismatic":
      if (constraint.axis === undefined) {
        throw new PhysicsConstraintMissingAxisError(constraint);
      }
      return RAPIER.JointData.prismatic(anchorA, anchorB, toRapierVector(constraint.axis));
  }
}

/** One rigid body this bake owns, tracked for per-frame readback (dynamic) or feed-forward (kinematic). */
interface BakedBody {
  nodeId: string;
  bodyType: RigidBodyConfig["bodyType"];
  rigidBody: RAPIER.RigidBody;
  /** Only set for a `"kinematic"` body: re-resolved every step and fed into the simulation via `setNextKinematicTranslation`/`.Rotation`. */
  transform?: MeshNode["transform"];
}

/**
 * A composition's own physics simulation, stepped incrementally by
 * `advanceTo`. Deterministic: the same sequence of `advanceTo` calls always
 * produces the same result, since `@dimforge/rapier3d-compat`'s own
 * simulation is a pure function of its current state and fixed timestep -
 * no wall-clock or unseeded randomness anywhere in this module.
 */
export interface PhysicsBake {
  /**
   * Advances (or, for a backward seek, resets and re-simulates from frame
   * 0) to `frame`, returning every dynamic body's own resolved pose at
   * that frame, by node id. Fixed and kinematic bodies are never included
   * here: a fixed body's pose never changes past frame 0, and a kinematic
   * body's own authored `transform` already drives its rendered pose
   * unchanged (see `RigidBodyConfig`'s own doc).
   */
  advanceTo(frame: number): ReadonlyMap<string, PhysicsTransform>;
  /** Frees the underlying physics world and everything in it. */
  dispose(): void;
}

/**
 * Builds a `PhysicsBake` for one composition: walks `roots` (a composition's
 * own resolved `SceneState.layers[].node`s) for every `MeshNode` with
 * `rigidBody` set, constructs a `@dimforge/rapier3d-compat` world at
 * `fps`-derived fixed timestep (`CompositionPhysics.substeps` sub-steps per
 * rendered frame), and wires `constraints` as joints between named bodies.
 *
 * Each body's initial pose comes from its own `MeshNode.transform`,
 * resolved once at frame 0 - not re-read on every step for a `"dynamic"`
 * body (physics owns its motion from then on), but re-read every step for
 * a `"kinematic"` one (see `RigidBodyConfig`'s own doc for why).
 *
 * Determinism constraints (see `CompositionPhysics`'s own doc, `@cadra/core`,
 * for the full explanation): reproducible on the same `@dimforge/rapier3d-
 * compat` build and CPU architecture, since it is an ordinary IEEE 754
 * floating-point simulation, not a bit-identical guarantee across different
 * builds/architectures.
 */
export function createPhysicsBake(
  roots: SceneNode[],
  physics: CompositionPhysics | undefined,
  constraints: PhysicsConstraintConfig[] | undefined,
  fps: number,
): PhysicsBake {
  const resolvedPhysics = resolveCompositionPhysics(physics);
  const meshNodes = collectPhysicsMeshNodes(roots);

  let world: RAPIER.World;
  let bodies: BakedBody[];
  let currentFrame: number;
  let lastResult: ReadonlyMap<string, PhysicsTransform>;

  function readTransforms(): ReadonlyMap<string, PhysicsTransform> {
    const result = new Map<string, PhysicsTransform>();
    for (const body of bodies) {
      if (body.bodyType !== "dynamic") {
        continue;
      }
      const translation = body.rigidBody.translation();
      const rotation = body.rigidBody.rotation();
      result.set(body.nodeId, {
        position: [translation.x, translation.y, translation.z],
        rotation: quaternionToEulerXyz(rotation),
      });
    }
    return result;
  }

  function setupWorld(): void {
    world?.free();
    world = new RAPIER.World(toRapierVector(resolvedPhysics.gravity));
    world.timestep = 1 / fps / resolvedPhysics.substeps;

    const rigidBodiesByNodeId = new Map<string, RAPIER.RigidBody>();
    bodies = [];

    for (const node of meshNodes) {
      const position = resolveVector3Property(node.transform.position, 0);
      const rotation = resolveVector3Property(node.transform.rotation, 0);

      const rigidBody = world.createRigidBody(buildRigidBodyDesc(node.rigidBody, position, rotation));
      world.createCollider(buildColliderDescWithMaterial(node.rigidBody), rigidBody);

      rigidBodiesByNodeId.set(node.id, rigidBody);
      bodies.push({
        nodeId: node.id,
        bodyType: node.rigidBody.bodyType,
        rigidBody,
        ...(node.rigidBody.bodyType === "kinematic" && { transform: node.transform }),
      });
    }

    for (const constraint of constraints ?? []) {
      const bodyA = rigidBodiesByNodeId.get(constraint.bodyA);
      if (bodyA === undefined) {
        throw new PhysicsConstraintBodyNotFoundError(constraint, "bodyA");
      }
      const bodyB = rigidBodiesByNodeId.get(constraint.bodyB);
      if (bodyB === undefined) {
        throw new PhysicsConstraintBodyNotFoundError(constraint, "bodyB");
      }
      world.createImpulseJoint(buildJointData(constraint), bodyA, bodyB, true);
    }

    currentFrame = 0;
    lastResult = readTransforms();
  }

  function stepToNextFrame(frame: number): void {
    for (const body of bodies) {
      if (body.bodyType === "kinematic" && body.transform !== undefined) {
        const position = resolveVector3Property(body.transform.position, frame);
        const rotation = resolveVector3Property(body.transform.rotation, frame);
        body.rigidBody.setNextKinematicTranslation(toRapierVector(position));
        body.rigidBody.setNextKinematicRotation(eulerXyzToQuaternion(rotation));
      }
    }
    for (let substep = 0; substep < resolvedPhysics.substeps; substep += 1) {
      world.step();
    }
  }

  setupWorld();

  function advanceTo(frame: number): ReadonlyMap<string, PhysicsTransform> {
    if (frame === currentFrame) {
      return lastResult;
    }
    if (frame < currentFrame) {
      setupWorld();
    }
    while (currentFrame < frame) {
      currentFrame += 1;
      stepToNextFrame(currentFrame);
    }
    lastResult = readTransforms();
    return lastResult;
  }

  function dispose(): void {
    world.free();
  }

  return { advanceTo, dispose };
}
