import { createIdentityTransform, type SceneNode } from "@cadra/core";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { applyNodeProperties, createThreeObject, type NodeFactoryContext } from "./node-factory.js";
import { createDefaultGeometryRegistry, createDefaultMaterialRegistry } from "./registries.js";

function makeCtx(): NodeFactoryContext {
  return {
    geometryRegistry: createDefaultGeometryRegistry(),
    materialRegistry: createDefaultMaterialRegistry(),
  };
}

function meshNode(geometryRef: string, materialRef: string): SceneNode {
  return {
    id: "m",
    kind: "mesh",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    geometryRef,
    materialRef,
  };
}

describe("node-factory: unresolved mesh refs fall back to shared singletons, not fresh allocations", () => {
  it("returns the exact same fallback geometry instance across multiple unresolved mesh nodes", () => {
    const ctx = makeCtx();
    const first = createThreeObject(meshNode("missing-a", "missing-x"), ctx).object3D as THREE.Mesh;
    const second = createThreeObject(meshNode("missing-b", "missing-y"), ctx)
      .object3D as THREE.Mesh;
    expect(first.geometry).toBe(second.geometry);
    expect(first.material).toBe(second.material);
  });

  it("returns the exact same fallback geometry instance across repeated applyNodeProperties calls", () => {
    const ctx = makeCtx();
    const built = createThreeObject(meshNode("missing-a", "missing-x"), ctx);
    const initialGeometry = (built.object3D as THREE.Mesh).geometry;

    applyNodeProperties(meshNode("missing-a", "missing-x"), built.object3D, ctx, 0);

    expect((built.object3D as THREE.Mesh).geometry).toBe(initialGeometry);
  });

  it("createThreeObject reports no owned resources for a mesh node (geometry/material are registry or fallback owned)", () => {
    const ctx = makeCtx();
    const built = createThreeObject(meshNode("box", "default"), ctx);
    expect(built.owned).toBeUndefined();
  });
});
