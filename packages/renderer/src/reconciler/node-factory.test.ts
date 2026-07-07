import { createIdentityTransform, type SceneNode } from "@cadra/core";
import type { TextRenderData } from "@cadra/text";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { TextGroupResources } from "../text/build-text-group.js";
import { createInMemoryTextRenderRegistry } from "../text/text-render-registry.js";
import { applyNodeProperties, createThreeObject, type NodeFactoryContext } from "./node-factory.js";
import { createDefaultGeometryRegistry, createDefaultMaterialRegistry } from "./registries.js";

function makeCtx(): NodeFactoryContext {
  return {
    geometryRegistry: createDefaultGeometryRegistry(),
    materialRegistry: createDefaultMaterialRegistry(),
  };
}

/** A minimal, structurally-valid `TextRenderData` (one glyph, one atlas page): real shaping/atlas generation is `@cadra/text`'s own test responsibility, not this reconciler's. */
const FAKE_TEXT_RENDER_DATA: TextRenderData = {
  lineCount: 1,
  atlasPages: [{ width: 4, height: 4, pixels: new Uint8Array(4 * 4 * 4).fill(255), png: new Uint8Array() }],
  glyphs: [
    {
      glyphId: 1,
      cluster: 0,
      lineIndex: 0,
      wordIndex: 0,
      origin: { x: 0, y: 0 },
      quad: { left: 0, right: 1, bottom: 0, top: 1 },
      page: 0,
      uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
    },
  ],
};

/** `makeCtx` plus a `textRenderRegistry` pre-populated with `FAKE_TEXT_RENDER_DATA` under the given text node's own render key ("default::"+content). */
function makeCtxWithText(content: string): NodeFactoryContext {
  const textRenderRegistry = createInMemoryTextRenderRegistry();
  textRenderRegistry.register(`default::${content}`, {
    data: FAKE_TEXT_RENDER_DATA,
    fontBytes: new Uint8Array(),
    fontContentHash: "fake-font",
  });
  return { ...makeCtx(), textRenderRegistry };
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
    const ctx = makeCtxWithText("Hello");
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
    // MSDF materials hold their color in a TSL uniform node, not the
    // classic `.color` property (see msdf-material.ts), so this asserts
    // through the same setColor seam applyNodeProperties itself calls,
    // rather than reading a material property that would not reflect it.
    const textResources = built.owned?.text as TextGroupResources;
    const setColorSpy = vi.spyOn(textResources, "setColor");

    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    expect(setColorSpy).toHaveBeenLastCalledWith(1, 0, 0, 1);

    applyNodeProperties(node, built.object3D, ctx, 10, built.owned);
    expect(setColorSpy).toHaveBeenLastCalledWith(0, 0, 1, 1);
  });

  it("renders an empty group when a text node's render data is not yet registered", () => {
    const ctx = makeCtx();
    const node: SceneNode = {
      id: "title",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content: "Hello",
      fontSize: 24,
      color: [1, 1, 1, 1],
    };
    const built = createThreeObject(node, ctx);

    expect(built.object3D).toBeInstanceOf(THREE.Group);
    expect(built.object3D.children).toHaveLength(0);
    expect(built.owned).toBeUndefined();
  });

  it("builds real glyph meshes grouped under line and word groups when render data is registered", () => {
    const ctx = makeCtxWithText("Hi");
    const node: SceneNode = {
      id: "title",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content: "Hi",
      fontSize: 24,
      color: [1, 1, 1, 1],
    };
    const built = createThreeObject(node, ctx);
    const group = built.object3D as THREE.Group;

    const lineGroup = group.children[0] as THREE.Group;
    expect(lineGroup.name).toBe("line-0");
    const wordGroup = lineGroup.children[0] as THREE.Group;
    expect(wordGroup.name).toBe("word-0:0");
    expect(wordGroup.children[0]).toBeInstanceOf(THREE.Mesh);
  });

  it("scales the text group by the resolved fontSize each frame, on top of the authored transform scale", () => {
    const ctx = makeCtxWithText("Hi");
    const node: SceneNode = {
      id: "title",
      kind: "text",
      transform: { ...createIdentityTransform(), scale: [2, 2, 2] },
      visible: true,
      children: [],
      content: "Hi",
      fontSize: 10,
      color: [1, 1, 1, 1],
    };
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    expect(built.object3D.scale.toArray()).toEqual([20, 20, 20]);
  });
});
