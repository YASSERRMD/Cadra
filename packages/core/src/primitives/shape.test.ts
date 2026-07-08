import { describe, expect, it } from "vitest";

import { createIdentityTransform, type Transform } from "../scene-graph/primitives.js";
import type { RigidBodyConfig } from "../scene-graph/scene-node.js";
import { Shape } from "./shape.js";

describe("Shape", () => {
  it("applies every default when only id is given", () => {
    const node = Shape({ id: "shape-1" });

    expect(node).toEqual({
      id: "shape-1",
      kind: "mesh",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      geometryRef: "box",
      materialRef: "default",
    });
  });

  it("does not set a name key when name is omitted", () => {
    const node = Shape({ id: "shape-1" });

    expect("name" in node).toBe(false);
  });

  it("does not set material, castShadow, receiveShadow, or rigidBody keys when omitted", () => {
    const node = Shape({ id: "shape-1" });

    expect("material" in node).toBe(false);
    expect("castShadow" in node).toBe(false);
    expect("receiveShadow" in node).toBe(false);
    expect("rigidBody" in node).toBe(false);
  });

  it("overrides every default when props are given", () => {
    const transform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] };
    const child = Shape({ id: "child" });
    const rigidBody: RigidBodyConfig = { bodyType: "dynamic", collider: { shape: "box", halfExtents: [1, 1, 1] } };

    const node = Shape({
      id: "shape-1",
      name: "My Shape",
      transform,
      visible: false,
      children: [child],
      geometryRef: "sphere",
      materialRef: "glass",
      material: { baseColor: [0.8, 0.2, 0.2, 1], metalness: 1, roughness: 0.3 },
      castShadow: true,
      receiveShadow: true,
      rigidBody,
    });

    expect(node).toEqual({
      id: "shape-1",
      kind: "mesh",
      name: "My Shape",
      transform,
      visible: false,
      children: [child],
      geometryRef: "sphere",
      materialRef: "glass",
      material: { baseColor: [0.8, 0.2, 0.2, 1], metalness: 1, roughness: 0.3 },
      castShadow: true,
      receiveShadow: true,
      rigidBody,
    });
  });

  it("passing visible explicitly overrides the true default", () => {
    expect(Shape({ id: "s", visible: false }).visible).toBe(false);
    expect(Shape({ id: "s", visible: true }).visible).toBe(true);
  });
});
