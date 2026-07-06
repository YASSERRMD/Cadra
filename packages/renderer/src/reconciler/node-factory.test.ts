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

describe("node-factory: createThreeObject tags object3D.name with the originating SceneNode.id", () => {
  it("sets .name to the node's id for a mesh node", () => {
    const ctx = makeCtx();
    const built = createThreeObject(meshNode("box", "default"), ctx);
    expect(built.object3D.name).toBe("m");
  });

  it("sets .name to the node's id for every other node kind too", () => {
    const ctx = makeCtx();
    const cameraNode: SceneNode = {
      id: "cam-1",
      kind: "camera",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      fov: 50,
      near: 0.1,
      far: 1000,
      target: [0, 0, 0],
    };
    const built = createThreeObject(cameraNode, ctx);
    expect(built.object3D.name).toBe("cam-1");
  });
});

describe("node-factory: Phase 26 keyframed properties resolve to different values across frames", () => {
  it("resolves a keyframed transform.position to different world positions at different frames", () => {
    const ctx = makeCtx();
    const node: SceneNode = {
      id: "moving-box",
      kind: "mesh",
      transform: {
        position: {
          type: "keyframeTrack",
          keyframes: [
            { frame: 0, value: [0, 0, 0] },
            { frame: 10, value: [10, 20, 30] },
          ],
        },
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      children: [],
      geometryRef: "box",
      materialRef: "default",
    };
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 0);
    expect(built.object3D.position.toArray()).toEqual([0, 0, 0]);

    applyNodeProperties(node, built.object3D, ctx, 5);
    expect(built.object3D.position.toArray()).toEqual([5, 10, 15]);

    applyNodeProperties(node, built.object3D, ctx, 10);
    expect(built.object3D.position.toArray()).toEqual([10, 20, 30]);
  });

  it("resolves a keyframed transform.scale independently of position and rotation", () => {
    const ctx = makeCtx();
    const node: SceneNode = {
      id: "scaling-box",
      kind: "mesh",
      transform: {
        position: [1, 1, 1],
        rotation: [0, 0, 0],
        scale: {
          type: "keyframeTrack",
          keyframes: [
            { frame: 0, value: [1, 1, 1] },
            { frame: 10, value: [3, 3, 3] },
          ],
        },
      },
      visible: true,
      children: [],
      geometryRef: "box",
      materialRef: "default",
    };
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 0);
    expect(built.object3D.scale.toArray()).toEqual([1, 1, 1]);
    expect(built.object3D.position.toArray()).toEqual([1, 1, 1]);

    applyNodeProperties(node, built.object3D, ctx, 10);
    expect(built.object3D.scale.toArray()).toEqual([3, 3, 3]);
    // Position stayed a plain constant: unaffected by scale's own keyframe track.
    expect(built.object3D.position.toArray()).toEqual([1, 1, 1]);
  });

  it("resolves a 'hold'-eased keyframed visible to a discrete step, not a blend", () => {
    const ctx = makeCtx();
    const node: SceneNode = {
      id: "toggling-box",
      kind: "mesh",
      transform: createIdentityTransform(),
      visible: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: true, easing: "hold" },
          { frame: 10, value: false },
        ],
      },
      children: [],
      geometryRef: "box",
      materialRef: "default",
    };
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 0);
    expect(built.object3D.visible).toBe(true);

    applyNodeProperties(node, built.object3D, ctx, 5);
    expect(built.object3D.visible).toBe(true);

    applyNodeProperties(node, built.object3D, ctx, 10);
    expect(built.object3D.visible).toBe(false);
  });

  it("resolves a keyframed light color and intensity to different values at different frames", () => {
    const ctx = makeCtx();
    const node: SceneNode = {
      id: "key-light",
      kind: "light",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      lightType: "point",
      color: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [0, 0, 0, 1] },
          { frame: 10, value: [1, 1, 1, 1] },
        ],
      },
      intensity: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 10, value: 2 },
        ],
      },
    };
    const built = createThreeObject(node, ctx);
    const light = built.object3D as THREE.Light;

    applyNodeProperties(node, built.object3D, ctx, 0);
    expect(light.intensity).toBe(0);
    expect([light.color.r, light.color.g, light.color.b]).toEqual([0, 0, 0]);

    applyNodeProperties(node, built.object3D, ctx, 5);
    expect(light.intensity).toBe(1);
    expect([light.color.r, light.color.g, light.color.b]).toEqual([0.5, 0.5, 0.5]);

    applyNodeProperties(node, built.object3D, ctx, 10);
    expect(light.intensity).toBe(2);
    expect([light.color.r, light.color.g, light.color.b]).toEqual([1, 1, 1]);
  });

  it("resolves a keyframed text color to different values at different frames", () => {
    const ctx = makeCtx();
    const node: SceneNode = {
      id: "title",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content: "Hello",
      fontSize: 24,
      color: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [1, 0, 0, 1] },
          { frame: 10, value: [0, 0, 1, 1] },
        ],
      },
    };
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;

    applyNodeProperties(node, built.object3D, ctx, 0);
    expect([material.color.r, material.color.g, material.color.b]).toEqual([1, 0, 0]);

    applyNodeProperties(node, built.object3D, ctx, 10);
    expect([material.color.r, material.color.g, material.color.b]).toEqual([0, 0, 1]);
  });
});
