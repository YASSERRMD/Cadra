import type { MeshNode, PhysicsConstraintConfig, RigidBodyConfig, SceneNode } from "@cadra/core";
import { createIdentityTransform } from "@cadra/core";
import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";

import {
  PhysicsConstraintBodyNotFoundError,
  PhysicsConstraintMissingAxisError,
} from "./errors.js";
import { createPhysicsBake } from "./physics-bake.js";

beforeAll(async () => {
  await RAPIER.init();
});

/** A mesh node with the given `rigidBody`, at the given initial position, no children. */
function physicsMesh(id: string, rigidBody: RigidBodyConfig, position: [number, number, number] = [0, 0, 0]): MeshNode {
  return {
    id,
    kind: "mesh",
    transform: { ...createIdentityTransform(), position },
    visible: true,
    children: [],
    geometryRef: "box",
    materialRef: "default",
    rigidBody,
  };
}

const FPS = 30;

describe("createPhysicsBake: a single falling dynamic body", () => {
  it("falls under gravity: position.y strictly decreases frame over frame", () => {
    const ball = physicsMesh("ball", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.5 } }, [0, 10, 0]);
    const bake = createPhysicsBake([ball], undefined, undefined, FPS);

    let previousY = bake.advanceTo(0).get("ball")!.position[1];
    for (let frame = 1; frame <= 10; frame += 1) {
      const currentY = bake.advanceTo(frame).get("ball")!.position[1];
      expect(currentY).toBeLessThan(previousY);
      previousY = currentY;
    }

    bake.dispose();
  });

  it("advanceTo(0) reports the body's own authored initial position, before any stepping", () => {
    const ball = physicsMesh("ball", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.5 } }, [1, 10, 2]);
    const bake = createPhysicsBake([ball], undefined, undefined, FPS);

    const initial = bake.advanceTo(0);
    expect(initial.get("ball")!.position).toEqual([1, 10, 2]);

    bake.dispose();
  });

  it("is deterministic: two independent bakes of the same scene produce byte-identical results", () => {
    const buildBake = () => {
      const ball = physicsMesh(
        "ball",
        { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.5 }, restitution: 0.6 },
        [0, 10, 0],
      );
      return createPhysicsBake([ball], undefined, undefined, FPS);
    };

    const first = buildBake();
    const second = buildBake();

    for (const frame of [1, 5, 15, 30, 60]) {
      expect(second.advanceTo(frame)).toEqual(first.advanceTo(frame));
    }

    first.dispose();
    second.dispose();
  });

  it("seeking backward resets and re-simulates, matching a fresh bake advanced directly to the same frame", () => {
    const buildBall = () =>
      physicsMesh("ball", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.5 } }, [0, 10, 0]);

    const scrubbed = createPhysicsBake([buildBall()], undefined, undefined, FPS);
    scrubbed.advanceTo(20);
    const afterSeekBack = scrubbed.advanceTo(5);

    const direct = createPhysicsBake([buildBall()], undefined, undefined, FPS);
    const directAtFive = direct.advanceTo(5);

    expect(afterSeekBack).toEqual(directAtFive);

    scrubbed.dispose();
    direct.dispose();
  });

  it("returns the cached result, without re-stepping, when asked for the same frame twice", () => {
    const ball = physicsMesh("ball", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.5 } }, [0, 10, 0]);
    const bake = createPhysicsBake([ball], undefined, undefined, FPS);

    const first = bake.advanceTo(10);
    const second = bake.advanceTo(10);
    expect(second).toBe(first);

    bake.dispose();
  });
});

describe("createPhysicsBake: fixed and kinematic bodies", () => {
  it("never includes a fixed body in advanceTo's own result map", () => {
    const ground = physicsMesh("ground", { bodyType: "fixed", collider: { shape: "box", halfExtents: [10, 1, 10] } }, [0, -1, 0]);
    const bake = createPhysicsBake([ground], undefined, undefined, FPS);

    expect(bake.advanceTo(30).has("ground")).toBe(false);

    bake.dispose();
  });

  it("never includes a kinematic body in advanceTo's own result map, even as it animates", () => {
    const platform = physicsMesh("platform", {
      bodyType: "kinematic",
      collider: { shape: "box", halfExtents: [2, 0.5, 2] },
    });
    platform.transform.position = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0] },
        { frame: 30, value: [5, 0, 0] },
      ],
    };

    const bake = createPhysicsBake([platform], undefined, undefined, FPS);

    expect(bake.advanceTo(15).has("platform")).toBe(false);

    bake.dispose();
  });

  it("a dynamic body resting on a fixed ground does not fall through it", () => {
    const ground = physicsMesh("ground", { bodyType: "fixed", collider: { shape: "box", halfExtents: [10, 1, 10] } }, [0, -1, 0]);
    const box = physicsMesh("box", { bodyType: "dynamic", collider: { shape: "box", halfExtents: [0.5, 0.5, 0.5] } }, [0, 2, 0]);
    const bake = createPhysicsBake([ground, box], undefined, undefined, FPS);

    const settled = bake.advanceTo(120).get("box")!;
    // Resting on top of a ground surface at y=0 (ground center -1, half-extent
    // 1) with a 0.5 half-extent box: the box's own center settles close to
    // 0.5, comfortably above having fallen through to a large negative y.
    expect(settled.position[1]).toBeGreaterThan(0);
    expect(settled.position[1]).toBeLessThan(2);

    bake.dispose();
  });
});

describe("createPhysicsBake: a stack of colliding bodies (Phase 66 acceptance criterion)", () => {
  function buildStackNodes(): SceneNode[] {
    const ground = physicsMesh(
      "ground",
      { bodyType: "fixed", collider: { shape: "box", halfExtents: [10, 1, 10] } },
      [0, -1, 0],
    );
    const lower = physicsMesh(
      "lower",
      { bodyType: "dynamic", collider: { shape: "box", halfExtents: [0.5, 0.5, 0.5] }, friction: 0.8 },
      [0, 3, 0],
    );
    const upper = physicsMesh(
      "upper",
      { bodyType: "dynamic", collider: { shape: "box", halfExtents: [0.5, 0.5, 0.5] }, friction: 0.8 },
      [0.05, 5, 0],
    );
    return [ground, lower, upper];
  }

  it("simulates identically across repeated runs on the same build", () => {
    const first = createPhysicsBake(buildStackNodes(), undefined, undefined, FPS);
    const second = createPhysicsBake(buildStackNodes(), undefined, undefined, FPS);

    for (const frame of [10, 30, 60, 90, 150]) {
      expect(second.advanceTo(frame)).toEqual(first.advanceTo(frame));
    }

    first.dispose();
    second.dispose();
  });

  it("both boxes come to rest above the ground, neither falling through nor flying away", () => {
    const bake = createPhysicsBake(buildStackNodes(), undefined, undefined, FPS);

    const settled = bake.advanceTo(150);
    const lowerY = settled.get("lower")!.position[1];
    const upperY = settled.get("upper")!.position[1];
    expect(lowerY).toBeGreaterThan(-1);
    expect(lowerY).toBeLessThan(10);
    expect(upperY).toBeGreaterThan(lowerY);
    expect(upperY).toBeLessThan(10);

    bake.dispose();
  });
});

describe("createPhysicsBake: constraints", () => {
  it("a fixed joint holds two dynamic bodies at a constant relative offset while falling", () => {
    const bodyA = physicsMesh("body-a", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.3 } }, [0, 10, 0]);
    const bodyB = physicsMesh("body-b", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.3 } }, [1, 10, 0]);
    const constraints: PhysicsConstraintConfig[] = [
      { id: "weld", type: "fixed", bodyA: "body-a", bodyB: "body-b", anchorA: [0.5, 0, 0], anchorB: [-0.5, 0, 0] },
    ];
    const bake = createPhysicsBake([bodyA, bodyB], undefined, constraints, FPS);

    const atFrame30 = bake.advanceTo(30);
    const posA = atFrame30.get("body-a")!.position;
    const posB = atFrame30.get("body-b")!.position;
    const dx = posB[0] - posA[0];
    expect(dx).toBeCloseTo(1, 1);

    bake.dispose();
  });

  it("throws PhysicsConstraintBodyNotFoundError when bodyA does not resolve to any rigidBody-bearing node", () => {
    const bodyB = physicsMesh("body-b", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.3 } });
    const constraints: PhysicsConstraintConfig[] = [
      { id: "weld", type: "fixed", bodyA: "missing", bodyB: "body-b", anchorA: [0, 0, 0], anchorB: [0, 0, 0] },
    ];

    expect(() => createPhysicsBake([bodyB], undefined, constraints, FPS)).toThrow(
      PhysicsConstraintBodyNotFoundError,
    );
  });

  it("throws PhysicsConstraintMissingAxisError for a revolute constraint with no axis", () => {
    const bodyA = physicsMesh("body-a", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.3 } });
    const bodyB = physicsMesh("body-b", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.3 } });
    const constraints: PhysicsConstraintConfig[] = [
      { id: "hinge", type: "revolute", bodyA: "body-a", bodyB: "body-b", anchorA: [0, 0, 0], anchorB: [0, 0, 0] },
    ];

    expect(() => createPhysicsBake([bodyA, bodyB], undefined, constraints, FPS)).toThrow(
      PhysicsConstraintMissingAxisError,
    );
  });
});

describe("createPhysicsBake: nested nodes", () => {
  it("finds a rigidBody-bearing mesh nested under a plain group", () => {
    const nested = physicsMesh("nested-ball", { bodyType: "dynamic", collider: { shape: "sphere", radius: 0.5 } }, [0, 10, 0]);
    const group: SceneNode = {
      id: "group-1",
      kind: "group",
      transform: createIdentityTransform(),
      visible: true,
      children: [nested],
    };

    const bake = createPhysicsBake([group], undefined, undefined, FPS);
    expect(bake.advanceTo(10).has("nested-ball")).toBe(true);

    bake.dispose();
  });
});
