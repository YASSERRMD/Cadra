import {
  createIdentityTransform,
  type LightNode,
  type LightType,
  type MeshMaterialConfig,
  type MeshNode,
  type ModelNode,
  type SatoriNode,
  type SceneNode,
  type TextPhysicsConfig,
  type TextStaggerConfig,
  type VideoNode,
  type VolumeNode,
} from "@cadra/core";
import type { PhysicsTransform } from "@cadra/physics";
import type { RasterizedSvg } from "@cadra/svg-raster";
import type { TextRenderData } from "@cadra/text";
import * as THREE from "three";
import { VolumeNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";

import type { LoadedModel, ModelRegistry } from "../assets/model-registry.js";
import {
  computeSatoriLayerRenderKey,
  createInMemorySatoriLayerRenderRegistry,
} from "../svg-layer/satori-layer-render-registry.js";
import type { TextGroupResources } from "../text/build-text-group.js";
import { computeTextNodeRenderKey, createInMemoryTextRenderRegistry } from "../text/text-render-registry.js";
import { computeVideoFrameRenderKey, createInMemoryVideoFrameRegistry } from "../video-layer/video-frame-registry.js";
import { applyNodeProperties, createThreeObject, type NodeFactoryContext } from "./node-factory.js";
import { createDefaultGeometryRegistry, createDefaultMaterialRegistry } from "./registries.js";

function makeCtx(): NodeFactoryContext {
  return {
    geometryRegistry: createDefaultGeometryRegistry(),
    materialRegistry: createDefaultMaterialRegistry(),
    whiteBalanceGain: [1, 1, 1],
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
      range: 0.1,
    },
  ],
};

/** `makeCtx` plus a `textRenderRegistry` pre-populated with `FAKE_TEXT_RENDER_DATA` under the given text node's own render key. */
function makeCtxWithText(content: string): NodeFactoryContext {
  const textRenderRegistry = createInMemoryTextRenderRegistry();
  textRenderRegistry.register(computeTextNodeRenderKey({ content }, 0), {
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

describe("node-factory: image texture rendering", () => {
  function makeCtxWithTexture(entries: Record<string, THREE.Texture>): NodeFactoryContext {
    return {
      ...makeCtx(),
      textureRegistry: {
        resolve: (ref: string) => entries[ref],
      },
    };
  }

  function fakeTexture(width: number, height: number): THREE.Texture {
    // A plain { width, height } object satisfies everything this
    // reconciler's own image-sizing logic reads off `texture.image`; a
    // real ImageBitmap/HTMLImageElement is a browser-only construct this
    // Node test environment cannot create, exactly like every other
    // registry-resolved-texture fixture in this file (see satori's own
    // `fakeTexture` a few describe blocks below for the same pattern).
    return new THREE.Texture({ width, height } as unknown as HTMLImageElement);
  }

  it("falls back to the gray placeholder when no textureRegistry is injected at all", () => {
    const ctx = makeCtx();
    const built = createThreeObject(
      { id: "img", kind: "image", assetRef: "photo", transform: createIdentityTransform(), visible: true, children: [] },
      ctx,
    );
    const mesh = built.object3D as THREE.Mesh;
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBeNull();
    expect(built.owned?.image).toBeUndefined();
  });

  it("falls back to the gray placeholder when textureRegistry does not resolve this node's own assetRef", () => {
    const ctx = makeCtxWithTexture({ "other-asset": fakeTexture(100, 100) });
    const built = createThreeObject(
      { id: "img", kind: "image", assetRef: "photo", transform: createIdentityTransform(), visible: true, children: [] },
      ctx,
    );
    const mesh = built.object3D as THREE.Mesh;
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBeNull();
  });

  it("renders the real resolved texture, sized to its own aspect ratio, when textureRegistry resolves this node's assetRef", () => {
    const texture = fakeTexture(1920, 1080);
    const ctx = makeCtxWithTexture({ photo: texture });
    const built = createThreeObject(
      { id: "img", kind: "image", assetRef: "photo", transform: createIdentityTransform(), visible: true, children: [] },
      ctx,
    );
    const mesh = built.object3D as THREE.Mesh;

    expect((mesh.material as THREE.MeshBasicMaterial).map).toBe(texture);
    const geometry = mesh.geometry as THREE.PlaneGeometry;
    expect(geometry.parameters.width).toBe(1);
    expect(geometry.parameters.height).toBeCloseTo(1080 / 1920, 5);
    expect(built.owned?.image?.geometry).toBe(geometry);
  });

  it("gives every resolved image node its own geometry instance, never the shared placeholder singleton", () => {
    const texture = fakeTexture(200, 100);
    const ctx = makeCtxWithTexture({ photo: texture });
    const first = createThreeObject(
      { id: "img-1", kind: "image", assetRef: "photo", transform: createIdentityTransform(), visible: true, children: [] },
      ctx,
    ).object3D as THREE.Mesh;
    const second = createThreeObject(
      { id: "img-2", kind: "image", assetRef: "photo", transform: createIdentityTransform(), visible: true, children: [] },
      ctx,
    ).object3D as THREE.Mesh;

    // Same texture (registry-shared, correctly), but each node's own plane
    // geometry is its own instance, not aliased - a future per-node size
    // override (e.g. a differently-cropped aspect) must never leak across
    // two nodes that merely happen to share one assetRef today.
    expect(first.geometry).not.toBe(second.geometry);
  });

  it("still renders a real texture when its own natural width/height cannot be read (falls back to a 1:1 aspect, not a crash)", () => {
    const texture = new THREE.Texture({} as unknown as HTMLImageElement);
    const ctx = makeCtxWithTexture({ photo: texture });
    const built = createThreeObject(
      { id: "img", kind: "image", assetRef: "photo", transform: createIdentityTransform(), visible: true, children: [] },
      ctx,
    );
    const geometry = (built.object3D as THREE.Mesh).geometry as THREE.PlaneGeometry;
    expect(geometry.parameters.width).toBe(1);
    expect(geometry.parameters.height).toBe(1);
  });
});

describe("node-factory: video texture rendering", () => {
  function videoNode(overrides: Partial<VideoNode> = {}): VideoNode {
    return {
      id: "clip",
      kind: "video",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      assetRef: "movie",
      opacity: 1,
      ...overrides,
    };
  }

  // A plain { width, height } object satisfies everything this
  // reconciler's own frame-sizing logic reads off `entry.image`; a real
  // ImageBitmap is a browser-only construct this Node test environment
  // cannot create, exactly like "image texture rendering"'s own
  // `fakeTexture` above.
  function fakeVideoFrame(width: number, height: number): ImageBitmap {
    return { width, height } as unknown as ImageBitmap;
  }

  it("falls back to the gray placeholder when no videoFrameRegistry is injected at all", () => {
    const ctx = makeCtx();
    const node = videoNode();
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const mesh = built.object3D as THREE.Mesh;
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBeNull();
    expect(built.owned?.video).toBeUndefined();
  });

  it("falls back to the gray placeholder when videoFrameRegistry does not resolve this frame's render key", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    const node = videoNode();
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const mesh = built.object3D as THREE.Mesh;
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBeNull();
  });

  it("renders the real decoded frame, sized to its own aspect ratio, once videoFrameRegistry resolves this frame's render key", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    const node = videoNode();
    const renderKey = computeVideoFrameRenderKey(node, 0);
    videoFrameRegistry.register(renderKey, { image: fakeVideoFrame(1920, 1080) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const mesh = built.object3D as THREE.Mesh;
    const geometry = mesh.geometry as THREE.PlaneGeometry;
    expect(geometry.parameters.width).toBe(1);
    expect(geometry.parameters.height).toBeCloseTo(1080 / 1920, 5);
    expect((mesh.material as THREE.MeshBasicMaterial).map).not.toBeNull();
    expect(built.owned?.video?.geometry).toBe(geometry);
  });

  it("resolves opacity per frame, independent of whether the render key changed", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    const node = videoNode({
      opacity: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 10, value: 1 },
        ],
      },
    });
    const renderKey = computeVideoFrameRenderKey(node, 0);
    videoFrameRegistry.register(renderKey, { image: fakeVideoFrame(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const mesh = built.object3D as THREE.Mesh;
    expect((mesh.material as THREE.MeshBasicMaterial).opacity).toBe(0);

    applyNodeProperties(node, built.object3D, ctx, 10, built.owned);
    expect((mesh.material as THREE.MeshBasicMaterial).opacity).toBe(1);
  });

  it("swaps the geometry and material when a later composition frame resolves to a different source frame", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    const node = videoNode();
    const keyAtFrame0 = computeVideoFrameRenderKey(node, 0);
    const keyAtFrame10 = computeVideoFrameRenderKey(node, 10);
    expect(keyAtFrame0).not.toBe(keyAtFrame10);
    videoFrameRegistry.register(keyAtFrame0, { image: fakeVideoFrame(400, 200) });
    videoFrameRegistry.register(keyAtFrame10, { image: fakeVideoFrame(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const mesh = built.object3D as THREE.Mesh;
    const firstMaterial = mesh.material;
    const firstGeometry = mesh.geometry;

    applyNodeProperties(node, built.object3D, ctx, 10, built.owned);
    expect(mesh.material).not.toBe(firstMaterial);
    expect(mesh.geometry).not.toBe(firstGeometry);
  });

  it("does not rebuild the material or geometry across frames that resolve to the same source frame ('hold' past the trimmed range)", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    const node = videoNode({ inFrame: 0, outFrame: 5, outOfRangeBehavior: "hold" });
    const keyAtFrame5 = computeVideoFrameRenderKey(node, 5);
    const keyAtFrame20 = computeVideoFrameRenderKey(node, 20);
    expect(keyAtFrame5).toBe(keyAtFrame20);
    videoFrameRegistry.register(keyAtFrame5, { image: fakeVideoFrame(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 5, built.owned);
    const mesh = built.object3D as THREE.Mesh;
    const firstMaterial = mesh.material;
    const firstGeometry = mesh.geometry;

    // Both frames resolve to the same source frame (held past the trimmed
    // range), so this second call must not rebuild anything - proving the
    // "only rebuild when the key actually changes" optimization, not just
    // that it happens to still look correct.
    applyNodeProperties(node, built.object3D, ctx, 20, built.owned);
    expect(mesh.material).toBe(firstMaterial);
    expect(mesh.geometry).toBe(firstGeometry);
  });

  it("still renders a real frame when its own natural width/height cannot be read (falls back to a 1:1 aspect, not a crash)", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    const node = videoNode();
    const renderKey = computeVideoFrameRenderKey(node, 0);
    videoFrameRegistry.register(renderKey, { image: {} as unknown as ImageBitmap });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const geometry = (built.object3D as THREE.Mesh).geometry as THREE.PlaneGeometry;
    expect(geometry.parameters.width).toBe(1);
    expect(geometry.parameters.height).toBe(1);
  });

  it("maps every blendMode to the correct Three.js blending constant, mirroring satori's own mapping", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };

    const expected: Array<[VideoNode["blendMode"], THREE.Blending]> = [
      [undefined, THREE.NormalBlending],
      ["normal", THREE.NormalBlending],
      ["add", THREE.AdditiveBlending],
      ["multiply", THREE.MultiplyBlending],
      ["screen", THREE.CustomBlending],
    ];

    for (const [blendMode, blending] of expected) {
      const node = videoNode({ id: `node-${String(blendMode)}`, blendMode });
      const renderKey = computeVideoFrameRenderKey(node, 0);
      videoFrameRegistry.register(renderKey, { image: fakeVideoFrame(400, 200) });

      const built = createThreeObject(node, ctx);
      applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
      const mesh = built.object3D as THREE.Mesh;
      expect((mesh.material as THREE.MeshBasicMaterial).blending).toBe(blending);
    }
  });

  it("implements screen blending with the correct custom blend factors", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    const node = videoNode({ blendMode: "screen" });
    const renderKey = computeVideoFrameRenderKey(node, 0);
    videoFrameRegistry.register(renderKey, { image: fakeVideoFrame(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const mesh = built.object3D as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;

    expect(material.blendEquation).toBe(THREE.AddEquation);
    expect(material.blendSrc).toBe(THREE.OneMinusDstColorFactor);
    expect(material.blendDst).toBe(THREE.OneFactor);
  });

  it("reapplies blendMode every frame, even across frames whose render key does not change", () => {
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), videoFrameRegistry };
    // No inFrame/outFrame trim: frames 0 and 1 both resolve to source frame
    // 0/1 respectively (distinct keys), but the point here is that
    // blendMode - not itself a Property<T>, so there is no "same value"
    // fast path to accidentally skip - is read fresh on every single call,
    // proving this isn't only applied once at build/first-resolve time.
    const node = videoNode({ blendMode: "multiply" });
    videoFrameRegistry.register(computeVideoFrameRenderKey(node, 0), { image: fakeVideoFrame(400, 200) });
    videoFrameRegistry.register(computeVideoFrameRenderKey(node, 1), { image: fakeVideoFrame(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    applyNodeProperties(node, built.object3D, ctx, 1, built.owned);
    const mesh = built.object3D as THREE.Mesh;
    expect((mesh.material as THREE.MeshBasicMaterial).blending).toBe(THREE.MultiplyBlending);
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
    // Authored ColorRGBA is sRGB-encoded; resolveSceneColor converts it to
    // THREE's linear working space, so 0.5 sRGB is not 0.5 here. 0 and 1
    // are fixed points of the sRGB transfer function, so those stay exact.
    expect([light.color.r, light.color.g, light.color.b]).toEqual([
      0.2140411404715882, 0.2140411404715882, 0.2140411404715882,
    ]);

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

function fakeRasterizedSvg(width: number, height: number): RasterizedSvg {
  return { width, height, pixels: new Uint8Array(width * height * 4).fill(200) };
}

function satoriNode(overrides: Partial<SatoriNode> = {}): SatoriNode {
  return {
    id: "lower-third",
    kind: "satori",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    layer: { type: "div", children: ["Cadra"] },
    width: 400,
    height: 200,
    opacity: 1,
    ...overrides,
  };
}

describe("node-factory: satori", () => {
  it("renders an empty group when a satori node's render data is not yet registered", () => {
    const ctx = makeCtx();
    const node = satoriNode();
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    expect(built.object3D).toBeInstanceOf(THREE.Group);
    expect(built.object3D.children).toHaveLength(0);
  });

  it("builds a real textured mesh, sized from width/height, once render data is registered", () => {
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), satoriLayerRenderRegistry };
    const node = satoriNode();
    const renderKey = computeSatoriLayerRenderKey(node, 0);
    satoriLayerRenderRegistry.register(renderKey, { rasterized: fakeRasterizedSvg(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const group = built.object3D as THREE.Group;
    const mesh = group.children[0] as THREE.Mesh;
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    const geometry = mesh.geometry as THREE.PlaneGeometry;
    expect(geometry.parameters.width).toBe(400);
    expect(geometry.parameters.height).toBe(200);
    expect((mesh.material as THREE.MeshBasicMaterial).map).toBeInstanceOf(THREE.DataTexture);
  });

  it("resolves opacity per frame, independent of whether the render key changed", () => {
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), satoriLayerRenderRegistry };
    const node = satoriNode({
      opacity: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 10, value: 1 },
        ],
      },
    });
    const renderKey = computeSatoriLayerRenderKey(node, 0);
    satoriLayerRenderRegistry.register(renderKey, { rasterized: fakeRasterizedSvg(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const mesh = (built.object3D as THREE.Group).children[0] as THREE.Mesh;
    expect((mesh.material as THREE.MeshBasicMaterial).opacity).toBe(0);

    applyNodeProperties(node, built.object3D, ctx, 10, built.owned);
    expect((mesh.material as THREE.MeshBasicMaterial).opacity).toBe(1);
  });

  it("maps every blendMode to the correct Three.js blending constant", () => {
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), satoriLayerRenderRegistry };

    const expected: Array<[SatoriNode["blendMode"], THREE.Blending]> = [
      [undefined, THREE.NormalBlending],
      ["normal", THREE.NormalBlending],
      ["add", THREE.AdditiveBlending],
      ["multiply", THREE.MultiplyBlending],
      ["screen", THREE.CustomBlending],
    ];

    for (const [blendMode, blending] of expected) {
      const node = satoriNode({ id: `node-${String(blendMode)}`, blendMode });
      const renderKey = computeSatoriLayerRenderKey(node, 0);
      satoriLayerRenderRegistry.register(renderKey, { rasterized: fakeRasterizedSvg(400, 200) });

      const built = createThreeObject(node, ctx);
      applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
      const mesh = (built.object3D as THREE.Group).children[0] as THREE.Mesh;
      expect((mesh.material as THREE.MeshBasicMaterial).blending).toBe(blending);
    }
  });

  it("implements screen blending with the correct custom blend factors", () => {
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), satoriLayerRenderRegistry };
    const node = satoriNode({ blendMode: "screen" });
    const renderKey = computeSatoriLayerRenderKey(node, 0);
    satoriLayerRenderRegistry.register(renderKey, { rasterized: fakeRasterizedSvg(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const mesh = (built.object3D as THREE.Group).children[0] as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicMaterial;

    expect(material.blendEquation).toBe(THREE.AddEquation);
    expect(material.blendSrc).toBe(THREE.OneMinusDstColorFactor);
    expect(material.blendDst).toBe(THREE.OneFactor);
  });

  it("swaps the texture when a later frame resolves to a different render key", () => {
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), satoriLayerRenderRegistry };
    const node = satoriNode({
      elementAnimations: { title: { opacity: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] } } },
    });

    const keyAtFrame0 = computeSatoriLayerRenderKey(node, 0);
    const keyAtFrame10 = computeSatoriLayerRenderKey(node, 10);
    expect(keyAtFrame0).not.toBe(keyAtFrame10);
    satoriLayerRenderRegistry.register(keyAtFrame0, { rasterized: fakeRasterizedSvg(400, 200) });
    satoriLayerRenderRegistry.register(keyAtFrame10, { rasterized: fakeRasterizedSvg(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const mesh = (built.object3D as THREE.Group).children[0] as THREE.Mesh;
    const firstMaterial = mesh.material;
    const firstTexture = (firstMaterial as THREE.MeshBasicMaterial).map;

    applyNodeProperties(node, built.object3D, ctx, 10, built.owned);
    expect(mesh.material).not.toBe(firstMaterial);
    expect((mesh.material as THREE.MeshBasicMaterial).map).not.toBe(firstTexture);
  });

  it("does not rebuild the material or texture across frames that resolve to the same render key", () => {
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    const ctx: NodeFactoryContext = { ...makeCtx(), satoriLayerRenderRegistry };
    const node = satoriNode();
    const renderKey = computeSatoriLayerRenderKey(node, 0);
    satoriLayerRenderRegistry.register(renderKey, { rasterized: fakeRasterizedSvg(400, 200) });

    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    const mesh = (built.object3D as THREE.Group).children[0] as THREE.Mesh;
    const firstMaterial = mesh.material;

    // A static satori node (no elementAnimations) resolves the exact same
    // render key at every frame, so this second call must not rebuild
    // anything - proving the "only rebuild when the key actually changes"
    // optimization, not just that it happens to still look correct.
    applyNodeProperties(node, built.object3D, ctx, 1, built.owned);
    expect(mesh.material).toBe(firstMaterial);
  });
});

describe("node-factory: text stagger", () => {
  /** Two distinct glyphs (clusters 0 and 1, on one line/word), so a per-character stagger has two genuinely different units to reveal at different times. */
  const TWO_GLYPH_TEXT_RENDER_DATA: TextRenderData = {
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
        range: 0.1,
      },
      {
        glyphId: 2,
        cluster: 1,
        lineIndex: 0,
        wordIndex: 0,
        origin: { x: 1, y: 0 },
        quad: { left: 1, right: 2, bottom: 0, top: 1 },
        page: 0,
        uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
        range: 0.1,
      },
    ],
  };

  function makeCtxWithTwoGlyphText(content: string): NodeFactoryContext {
    const textRenderRegistry = createInMemoryTextRenderRegistry();
    textRenderRegistry.register(computeTextNodeRenderKey({ content }, 0), {
      data: TWO_GLYPH_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    return { ...makeCtx(), textRenderRegistry };
  }

  const TYPEWRITER: TextStaggerConfig = {
    preset: "typewriter",
    grouping: "character",
    startFrame: 0,
    delayFrames: 10,
    durationFrames: 1,
  };

  function staggeredTextNode(content: string, stagger: TextStaggerConfig): SceneNode {
    return {
      id: "t",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content,
      fontSize: 12,
      color: [1, 1, 1, 1],
      stagger,
    };
  }

  it("gives every glyph its own material for a staggered node (not shared across glyphs)", () => {
    const ctx = makeCtxWithTwoGlyphText("ab");
    const node = staggeredTextNode("ab", TYPEWRITER);
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const wordGroup = (built.object3D.children[0] as THREE.Group).children[0] as THREE.Group;
    const meshes = wordGroup.children as THREE.Mesh[];
    expect(meshes).toHaveLength(2);
    expect(meshes[0]?.material).not.toBe(meshes[1]?.material);
  });

  it("drives each glyph's own setOpacity independently, per frame, matching its own stagger rank", () => {
    const ctx = makeCtxWithTwoGlyphText("ab");
    const node = staggeredTextNode("ab", TYPEWRITER);
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const wordGroup = (built.object3D.children[0] as THREE.Group).children[0] as THREE.Group;
    const [firstMesh, secondMesh] = wordGroup.children as THREE.Mesh[];
    const firstSetOpacity = vi.spyOn(firstMesh?.userData as Record<string, (a: number) => void>, "setOpacity");
    const secondSetOpacity = vi.spyOn(secondMesh?.userData as Record<string, (a: number) => void>, "setOpacity");

    // Frame 1: rank 0 (cluster 0, window [0,1]) has finished revealing;
    // rank 1 (cluster 1, window [10,11]) has not started.
    applyNodeProperties(node, built.object3D, ctx, 1, built.owned);
    expect(firstSetOpacity).toHaveBeenLastCalledWith(1);
    expect(secondSetOpacity).toHaveBeenLastCalledWith(0);

    // Frame 11: rank 1 has now finished too.
    applyNodeProperties(node, built.object3D, ctx, 11, built.owned);
    expect(firstSetOpacity).toHaveBeenLastCalledWith(1);
    expect(secondSetOpacity).toHaveBeenLastCalledWith(1);
  });

  it("shares one material per glyph across the whole node when stagger is not set (unaffected by Phase 50)", () => {
    const ctx = makeCtxWithTwoGlyphText("ab");
    const node: SceneNode = {
      id: "t",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content: "ab",
      fontSize: 12,
      color: [1, 1, 1, 1],
    };
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const wordGroup = (built.object3D.children[0] as THREE.Group).children[0] as THREE.Group;
    const meshes = wordGroup.children as THREE.Mesh[];
    expect(meshes[0]?.material).toBe(meshes[1]?.material);
  });
});

describe("node-factory: text physics", () => {
  const TWO_GLYPH_TEXT_RENDER_DATA: TextRenderData = {
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
        range: 0.1,
      },
      {
        glyphId: 2,
        cluster: 1,
        lineIndex: 0,
        wordIndex: 0,
        origin: { x: 1, y: 0 },
        quad: { left: 1, right: 2, bottom: 0, top: 1 },
        page: 0,
        uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
        range: 0.1,
      },
    ],
  };

  function makeCtxWithTwoGlyphText(content: string): NodeFactoryContext {
    const textRenderRegistry = createInMemoryTextRenderRegistry();
    textRenderRegistry.register(computeTextNodeRenderKey({ content }, 0), {
      data: TWO_GLYPH_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    return { ...makeCtx(), textRenderRegistry };
  }

  const JITTER: TextPhysicsConfig = {
    effect: "jitter",
    grouping: "character",
    seed: 1,
    positionAmplitude: 0.4,
    periodFrames: 10,
  };

  function physicsTextNode(content: string, physics: TextPhysicsConfig, stagger?: TextStaggerConfig): SceneNode {
    return {
      id: "t",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content,
      fontSize: 12,
      color: [1, 1, 1, 1],
      physics,
      ...(stagger !== undefined && { stagger }),
    };
  }

  it("gives every glyph its own material for a physics-animated node (not shared across glyphs)", () => {
    const ctx = makeCtxWithTwoGlyphText("ab");
    const node = physicsTextNode("ab", JITTER);
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const wordGroup = (built.object3D.children[0] as THREE.Group).children[0] as THREE.Group;
    const meshes = wordGroup.children as THREE.Mesh[];
    expect(meshes[0]?.material).not.toBe(meshes[1]?.material);
  });

  it("drives each glyph's own position from the resolved jitter, independently per glyph", () => {
    const ctx = makeCtxWithTwoGlyphText("ab");
    const node = physicsTextNode("ab", JITTER);
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 5, built.owned);

    const wordGroup = (built.object3D.children[0] as THREE.Group).children[0] as THREE.Group;
    const [firstMesh, secondMesh] = wordGroup.children as THREE.Mesh[];
    const firstBase = firstMesh?.userData["basePosition"] as THREE.Vector3;
    const secondBase = secondMesh?.userData["basePosition"] as THREE.Vector3;

    expect(firstMesh?.position.x).not.toBeCloseTo(firstBase.x, 5);
    expect(secondMesh?.position.x).not.toBeCloseTo(secondBase.x, 5);
    // Different glyphs (different ranks) get independent, uncorrelated jitter.
    expect(firstMesh?.position.x).not.toBeCloseTo(secondMesh?.position.x as number, 5);
  });

  it("composes stagger and physics together on the same node", () => {
    const ctx = makeCtxWithTwoGlyphText("ab");
    const stagger: TextStaggerConfig = {
      preset: "fadeInUp",
      grouping: "character",
      startFrame: 0,
      delayFrames: 0,
      durationFrames: 10,
      distance: 1,
    };
    const node = physicsTextNode("ab", JITTER, stagger);
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 5, built.owned);

    const wordGroup = (built.object3D.children[0] as THREE.Group).children[0] as THREE.Group;
    const firstMesh = wordGroup.children[0] as THREE.Mesh;
    const firstBase = firstMesh.userData["basePosition"] as THREE.Vector3;

    // Neither effect alone would leave the glyph exactly at its own
    // fadeInUp-only offset (-0.5) nor exactly at its base position - the
    // jitter's own contribution must also be present.
    expect(firstMesh.position.y).not.toBeCloseTo(firstBase.y - 0.5, 3);
    expect(firstMesh.position.y).not.toBeCloseTo(firstBase.y, 3);
  });
});

describe("node-factory: text materials (Phase 53)", () => {
  function textNodeWith(extra: Partial<SceneNode>): SceneNode {
    return {
      id: "t",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content: "a",
      fontSize: 12,
      color: [1, 1, 1, 1],
      ...extra,
    } as SceneNode;
  }

  it("wires a gradient fill through to a real setFill on the built resources", () => {
    const ctx = makeCtxWithText("a");
    const node = textNodeWith({
      fill: {
        type: "linearGradient",
        stops: [
          { offset: 0, color: [1, 0, 0, 1] },
          { offset: 1, color: [0, 0, 1, 1] },
        ],
      },
    });
    const built = createThreeObject(node, ctx);

    expect(built.owned?.text?.setFill).toBeDefined();

    const setFillSpy = vi.spyOn(built.owned?.text as TextGroupResources, "setFill");
    applyNodeProperties(node, built.object3D, ctx, 5, built.owned);
    expect(setFillSpy).toHaveBeenCalledTimes(1);
  });

  it("does not expose setFill for a node with no fill configured", () => {
    const ctx = makeCtxWithText("a");
    const node = textNodeWith({});
    const built = createThreeObject(node, ctx);

    expect(built.owned?.text?.setFill).toBeUndefined();
  });

  it("wires an outline through to a real setOutline, re-resolved every frame", () => {
    const ctx = makeCtxWithText("a");
    const node = textNodeWith({
      outline: {
        width: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 0.1 }] },
        color: [0, 0, 0, 1],
      },
    });
    const built = createThreeObject(node, ctx);
    const setOutlineSpy = vi.spyOn(built.owned?.text as TextGroupResources, "setOutline");

    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    expect(setOutlineSpy).toHaveBeenLastCalledWith(expect.objectContaining({ width: 0 }));

    applyNodeProperties(node, built.object3D, ctx, 10, built.owned);
    expect(setOutlineSpy).toHaveBeenLastCalledWith(expect.objectContaining({ width: 0.1 }));
  });

  it("wires glow and shadow through to real setGlow/setShadow calls", () => {
    const ctx = makeCtxWithText("a");
    const node = textNodeWith({
      glow: { radius: 0.2, color: [1, 1, 0, 1] },
      shadow: { offsetX: 0.05, offsetY: 0.05, color: [0, 0, 0, 0.5] },
    });
    const built = createThreeObject(node, ctx);

    expect(built.owned?.text?.setGlow).toBeDefined();
    expect(built.owned?.text?.setShadow).toBeDefined();

    const setGlowSpy = vi.spyOn(built.owned?.text as TextGroupResources, "setGlow");
    const setShadowSpy = vi.spyOn(built.owned?.text as TextGroupResources, "setShadow");
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    expect(setGlowSpy).toHaveBeenCalledTimes(1);
    expect(setShadowSpy).toHaveBeenCalledTimes(1);
  });

  it("does not call setFill/setOutline/setGlow/setShadow at all when none are configured", () => {
    const ctx = makeCtxWithText("a");
    const node = textNodeWith({});
    const built = createThreeObject(node, ctx);

    expect(() => applyNodeProperties(node, built.object3D, ctx, 0, built.owned)).not.toThrow();
    expect(built.owned?.text?.setFill).toBeUndefined();
    expect(built.owned?.text?.setOutline).toBeUndefined();
    expect(built.owned?.text?.setGlow).toBeUndefined();
    expect(built.owned?.text?.setShadow).toBeUndefined();
  });
});

/** A mesh node with an inline PBR `material`, defaulting `geometryRef`/`materialRef` to the same placeholders `meshNode` uses. */
function meshNodeWithMaterial(material: MeshMaterialConfig): SceneNode {
  return {
    id: "m",
    kind: "mesh",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    geometryRef: "box",
    materialRef: "default",
    material,
  };
}

describe("node-factory: PBR mesh materials (Phase 55)", () => {
  it("builds a real MeshPhysicalMaterial from an inline material config, owned for disposal", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({ baseColor: [1, 1, 1, 1], metalness: 0.8, roughness: 0.3 });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;

    expect(mesh.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(built.owned?.material).toBe(mesh.material);
  });

  it("resolves metalness and roughness onto the constructed material", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({ metalness: 0.9, roughness: 0.15 });
    const built = createThreeObject(node, ctx);
    const material = (built.object3D as THREE.Mesh).material as THREE.MeshPhysicalMaterial;

    expect(material.metalness).toBe(0.9);
    expect(material.roughness).toBe(0.15);
  });

  it("resolves baseColor through the sRGB-to-linear scene color pipeline, matching a light's own color", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({ baseColor: [0.5, 0.5, 0.5, 1] });
    const built = createThreeObject(node, ctx);
    const material = (built.object3D as THREE.Mesh).material as THREE.MeshPhysicalMaterial;

    expect([material.color.r, material.color.g, material.color.b]).toEqual([
      0.2140411404715882, 0.2140411404715882, 0.2140411404715882,
    ]);
  });

  it("falls back to materialRef's registry-resolved material when no inline material is given (pre-Phase-55 behavior)", () => {
    const ctx = makeCtx();
    const node = meshNode("box", "default");
    const built = createThreeObject(node, ctx);

    expect(built.object3D).toBeInstanceOf(THREE.Mesh);
    expect((built.object3D as THREE.Mesh).material).toBe(ctx.materialRegistry.resolve("default"));
    expect(built.owned).toBeUndefined();
  });

  it("re-resolves keyframed metalness/roughness per frame, mutating the same owned material instance in place", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({
      metalness: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] },
      roughness: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 1 }, { frame: 10, value: 0 }] },
    });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    const materialBeforeUpdate = mesh.material;

    applyNodeProperties(node, mesh, ctx, 0, built.owned);
    expect((mesh.material as THREE.MeshPhysicalMaterial).metalness).toBe(0);
    expect((mesh.material as THREE.MeshPhysicalMaterial).roughness).toBe(1);

    applyNodeProperties(node, mesh, ctx, 10, built.owned);
    expect((mesh.material as THREE.MeshPhysicalMaterial).metalness).toBe(1);
    expect((mesh.material as THREE.MeshPhysicalMaterial).roughness).toBe(0);

    // Identity is preserved across frames: no reconstruction, no shader
    // recompile from scratch every frame.
    expect(mesh.material).toBe(materialBeforeUpdate);
  });

  it("defaults castShadow and receiveShadow to false, and applies them when set", () => {
    const ctx = makeCtx();
    const plainMesh = createThreeObject(meshNode("box", "default"), ctx).object3D as THREE.Mesh;
    expect(plainMesh.castShadow).toBe(false);
    expect(plainMesh.receiveShadow).toBe(false);

    const shadowedNode: SceneNode = {
      id: "m2",
      kind: "mesh",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      geometryRef: "box",
      materialRef: "default",
      castShadow: true,
      receiveShadow: true,
    };
    const shadowedMesh = createThreeObject(shadowedNode, ctx).object3D as THREE.Mesh;
    expect(shadowedMesh.castShadow).toBe(true);
    expect(shadowedMesh.receiveShadow).toBe(true);
  });
});

describe("node-factory: PBR advanced materials (Phase 64)", () => {
  it("resolves transmission, ior, and thickness onto the constructed material (a glass scene)", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({ transmission: 1, ior: 1.33, thickness: 0.6, roughness: 0.05 });
    const built = createThreeObject(node, ctx);
    const material = (built.object3D as THREE.Mesh).material as THREE.MeshPhysicalMaterial;

    expect(material.transmission).toBe(1);
    expect(material.ior).toBe(1.33);
    expect(material.thickness).toBe(0.6);
  });

  it("resolves sheen, sheenRoughness, and sheenColor onto the constructed material", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({
      sheen: 1,
      sheenRoughness: 0.3,
      sheenColor: [0.9, 0.7, 0.75, 1],
    });
    const built = createThreeObject(node, ctx);
    const material = (built.object3D as THREE.Mesh).material as THREE.MeshPhysicalMaterial;

    expect(material.sheen).toBe(1);
    expect(material.sheenRoughness).toBe(0.3);
    expect([material.sheenColor.r, material.sheenColor.g, material.sheenColor.b]).toEqual([
      0.7874122893910657, 0.4479884124320571, 0.5225215539594343,
    ]);
  });

  it("defaults transmission, sheen, and their dependent fields to Three.js's own no-effect values", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({});
    const built = createThreeObject(node, ctx);
    const material = (built.object3D as THREE.Mesh).material as THREE.MeshPhysicalMaterial;

    expect(material.transmission).toBe(0);
    expect(material.ior).toBe(1.5);
    expect(material.thickness).toBe(0);
    expect(material.sheen).toBe(0);
    expect(material.sheenRoughness).toBe(1);
    expect([material.sheenColor.r, material.sheenColor.g, material.sheenColor.b]).toEqual([0, 0, 0]);
  });

  it("re-resolves keyframed transmission and sheen per frame, mutating the same owned material instance in place", () => {
    const ctx = makeCtx();
    const node = meshNodeWithMaterial({
      transmission: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] },
      sheen: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }] },
    });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    const materialBeforeUpdate = mesh.material;

    applyNodeProperties(node, mesh, ctx, 0, built.owned);
    expect((mesh.material as THREE.MeshPhysicalMaterial).transmission).toBe(0);
    expect((mesh.material as THREE.MeshPhysicalMaterial).sheen).toBe(0);

    applyNodeProperties(node, mesh, ctx, 10, built.owned);
    expect((mesh.material as THREE.MeshPhysicalMaterial).transmission).toBe(1);
    expect((mesh.material as THREE.MeshPhysicalMaterial).sheen).toBe(1);

    expect(mesh.material).toBe(materialBeforeUpdate);
  });

  it("builds a metal material (Phase 55) and a glass material (Phase 64) as distinct, independently correct instances", () => {
    const ctx = makeCtx();
    const metal = createThreeObject(meshNodeWithMaterial({ metalness: 1, roughness: 0.35 }), ctx).object3D as THREE.Mesh;
    const glass = createThreeObject(
      meshNodeWithMaterial({ transmission: 1, ior: 1.5, roughness: 0.05 }),
      ctx,
    ).object3D as THREE.Mesh;

    const metalMaterial = metal.material as THREE.MeshPhysicalMaterial;
    const glassMaterial = glass.material as THREE.MeshPhysicalMaterial;

    expect(metalMaterial.metalness).toBe(1);
    expect(metalMaterial.transmission).toBe(0);
    expect(glassMaterial.transmission).toBe(1);
    expect(glassMaterial.metalness).toBe(0);
  });
});

/** A minimal, valid `VolumeNode`, with any given field overridden. */
function volumeNode(overrides: Partial<VolumeNode> = {}): VolumeNode {
  return {
    id: "volume-1",
    kind: "volume",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    shape: { type: "sphere", radius: 1 },
    color: [1, 1, 1, 1],
    density: 1,
    ...overrides,
  };
}

/** Mirrors `VolumeUniforms` (private to node-factory.ts): the shape stashed on `VolumeNodeMaterial.userData.volumeUniforms`, read back here only to assert `applyVolumeProperties` mutated the right values. */
interface TestVolumeUniforms {
  colorR: { value: number };
  colorG: { value: number };
  colorB: { value: number };
  densityMultiplier: { value: number };
  drift: { value: number };
}

describe("node-factory: volumetric smoke (Phase 68)", () => {
  it("renders an empty group with no owned resources on the WebGL2 backend (silent no-op)", () => {
    const ctx: NodeFactoryContext = { ...makeCtx(), backend: "webgl2" };
    const built = createThreeObject(volumeNode(), ctx);
    expect(built.object3D).toBeInstanceOf(THREE.Group);
    expect((built.object3D as THREE.Group).children.length).toBe(0);
    expect(built.owned).toBeUndefined();
  });

  it("also renders an empty group when the backend is not yet known (undefined, before init() resolves)", () => {
    const ctx = makeCtx();
    const built = createThreeObject(volumeNode(), ctx);
    expect(built.object3D).toBeInstanceOf(THREE.Group);
    expect(built.owned).toBeUndefined();
  });

  it("builds a real raymarched mesh with a box geometry sized from halfExtents, on the WebGPU backend", () => {
    const ctx: NodeFactoryContext = { ...makeCtx(), backend: "webgpu" };
    const node = volumeNode({ shape: { type: "box", halfExtents: [2, 3, 4] } });
    const built = createThreeObject(node, ctx);

    expect(built.object3D).toBeInstanceOf(THREE.Mesh);
    const mesh = built.object3D as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(VolumeNodeMaterial);
    const geometry = mesh.geometry as THREE.BoxGeometry;
    expect(geometry.parameters.width).toBe(4);
    expect(geometry.parameters.height).toBe(6);
    expect(geometry.parameters.depth).toBe(8);
    expect(built.owned?.volume?.geometry).toBe(mesh.geometry);
    expect(built.owned?.volume?.material).toBe(mesh.material);
  });

  it("builds a sphere geometry sized from radius, for a sphere shape", () => {
    const ctx: NodeFactoryContext = { ...makeCtx(), backend: "webgpu" };
    const node = volumeNode({ shape: { type: "sphere", radius: 2.5 } });
    const built = createThreeObject(node, ctx);
    const geometry = (built.object3D as THREE.Mesh).geometry as THREE.SphereGeometry;
    expect(geometry.parameters.radius).toBe(2.5);
  });

  it("defaults raymarchSteps to 25 and applies an explicit value onto the material", () => {
    const ctx: NodeFactoryContext = { ...makeCtx(), backend: "webgpu" };
    const defaultMesh = createThreeObject(volumeNode(), ctx).object3D as THREE.Mesh;
    expect((defaultMesh.material as VolumeNodeMaterial).steps).toBe(25);

    const customMesh = createThreeObject(volumeNode({ raymarchSteps: 40 }), ctx).object3D as THREE.Mesh;
    expect((customMesh.material as VolumeNodeMaterial).steps).toBe(40);
  });

  it("resolves color and density (scaled by the color's own alpha) onto the material's mutable uniforms", () => {
    const ctx: NodeFactoryContext = { ...makeCtx(), backend: "webgpu", fps: 30 };
    const node = volumeNode({ color: [1, 1, 1, 0.5], density: 2 });
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);

    const uniforms = built.owned?.volume?.material.userData.volumeUniforms as TestVolumeUniforms;
    expect(uniforms.colorR.value).toBeCloseTo(1);
    expect(uniforms.colorG.value).toBeCloseTo(1);
    expect(uniforms.colorB.value).toBeCloseTo(1);
    // density(2) * the color's own alpha(0.5)
    expect(uniforms.densityMultiplier.value).toBeCloseTo(1);
  });

  it("advances the drift uniform from driftSpeed (authored in units per second) and the composition's own fps", () => {
    const ctx: NodeFactoryContext = { ...makeCtx(), backend: "webgpu", fps: 20 };
    const node = volumeNode({ driftSpeed: 4 });
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 40, built.owned);

    const uniforms = built.owned?.volume?.material.userData.volumeUniforms as TestVolumeUniforms;
    // 4 units/sec * (40 frames / 20 fps) = 8
    expect(uniforms.drift.value).toBeCloseTo(8);
  });

  it("does not throw applying properties against the WebGL2 fallback's empty group (no owned.volume at all)", () => {
    const ctx: NodeFactoryContext = { ...makeCtx(), backend: "webgl2" };
    const node = volumeNode();
    const built = createThreeObject(node, ctx);
    expect(() => applyNodeProperties(node, built.object3D, ctx, 5, built.owned)).not.toThrow();
  });
});

/** A minimal, valid `ModelNode`, with any given field overridden. */
function modelNode(overrides: Partial<ModelNode> = {}): ModelNode {
  return {
    id: "model-1",
    kind: "model",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    assetRef: "character.glb",
    ...overrides,
  };
}

/** A `LoadedModel` with one plain (non-skinned) mesh named `"Body"` and no animations. */
function fakeLoadedModel(overrides: Partial<LoadedModel> = {}): LoadedModel {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.name = "Body";
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, animations: [], ...overrides };
}

/** A `LoadedModel` with a single `THREE.SkinnedMesh` bound to a two-bone skeleton, no animations. */
function fakeSkinnedLoadedModel(): LoadedModel {
  const rootBone = new THREE.Bone();
  const childBone = new THREE.Bone();
  childBone.position.y = 1;
  rootBone.add(childBone);
  const skeleton = new THREE.Skeleton([rootBone, childBone]);

  const geometry = new THREE.CylinderGeometry(0.2, 0.2, 2, 4);
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const vertexCount = geometry.attributes.position?.count ?? 0;
  for (let i = 0; i < vertexCount; i += 1) {
    skinIndices.push(0, 1, 0, 0);
    skinWeights.push(0.5, 0.5, 0, 0);
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial());
  mesh.name = "Rig";
  mesh.add(rootBone);
  mesh.bind(skeleton);

  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, animations: [] };
}

/** A `LoadedModel` with one plain mesh carrying two named morph targets, no animations. */
function fakeMorphLoadedModel(): LoadedModel {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.name = "Face";
  mesh.morphTargetDictionary = { smile: 0, frown: 1 };
  mesh.morphTargetInfluences = [0, 0];
  const scene = new THREE.Group();
  scene.add(mesh);
  return { scene, animations: [] };
}

/** A single-track `THREE.AnimationClip` linearly animating the clip root's own `position[axis]` from `0` at time `0` to `endValue` at time `duration`. */
function positionClip(name: string, axis: "x" | "y", endValue: number, duration = 1): THREE.AnimationClip {
  const track = new THREE.NumberKeyframeTrack(`.position[${axis}]`, [0, duration], [0, endValue]);
  return new THREE.AnimationClip(name, duration, [track]);
}

/** `makeCtx()` plus a `modelRegistry` pre-populated with `entries` (by `assetRef`). */
function makeCtxWithModel(entries: Record<string, LoadedModel>): NodeFactoryContext {
  const registry: ModelRegistry = {
    resolve(assetRef: string): LoadedModel | undefined {
      return entries[assetRef];
    },
  };
  return { ...makeCtx(), modelRegistry: registry, fps: 30 };
}

describe("node-factory: GLTF models, skeletal and morph animation (Phase 69)", () => {
  it("renders an empty group with no owned resources when assetRef is not registered", () => {
    const ctx = makeCtxWithModel({});
    const built = createThreeObject(modelNode(), ctx);
    expect(built.object3D).toBeInstanceOf(THREE.Group);
    expect((built.object3D as THREE.Group).children.length).toBe(0);
    expect(built.owned).toBeUndefined();
  });

  it("also renders an empty group when no modelRegistry is configured at all", () => {
    const ctx = makeCtx();
    const built = createThreeObject(modelNode(), ctx);
    expect(built.object3D).toBeInstanceOf(THREE.Group);
    expect(built.owned).toBeUndefined();
  });

  it("builds a clone of the registry entry's own scene, not the shared template itself", () => {
    const entry = fakeLoadedModel();
    const ctx = makeCtxWithModel({ "character.glb": entry });
    const built = createThreeObject(modelNode(), ctx);

    expect(built.object3D).not.toBe(entry.scene);
    expect(built.object3D.getObjectByName("Body")).toBeInstanceOf(THREE.Mesh);
    expect(built.object3D.getObjectByName("Body")).not.toBe(entry.scene.getObjectByName("Body"));
  });

  it("gives two reconciled instances of the same assetRef their own independent clone", () => {
    const entry = fakeLoadedModel();
    const ctx = makeCtxWithModel({ "character.glb": entry });

    const first = createThreeObject(modelNode({ id: "a" }), ctx);
    const second = createThreeObject(modelNode({ id: "b" }), ctx);

    expect(first.object3D).not.toBe(second.object3D);
  });

  it("defaults castShadow/receiveShadow to false and applies them to every mesh in the hierarchy", () => {
    const ctx = makeCtxWithModel({ "character.glb": fakeLoadedModel() });

    const plain = createThreeObject(modelNode(), ctx).object3D.getObjectByName("Body") as THREE.Mesh;
    expect(plain.castShadow).toBe(false);
    expect(plain.receiveShadow).toBe(false);

    const shadowed = createThreeObject(
      modelNode({ castShadow: true, receiveShadow: true }),
      ctx,
    ).object3D.getObjectByName("Body") as THREE.Mesh;
    expect(shadowed.castShadow).toBe(true);
    expect(shadowed.receiveShadow).toBe(true);
  });

  it("gives a cloned SkinnedMesh its own independent Skeleton, tracked in owned.model.skeletons", () => {
    const ctx = makeCtxWithModel({ "character.glb": fakeSkinnedLoadedModel() });
    const originalMesh = (ctx.modelRegistry?.resolve("character.glb") as LoadedModel).scene.getObjectByName(
      "Rig",
    ) as THREE.SkinnedMesh;

    const built = createThreeObject(modelNode(), ctx);
    const clonedMesh = built.object3D.getObjectByName("Rig") as THREE.SkinnedMesh;

    expect(clonedMesh.skeleton).not.toBe(originalMesh.skeleton);
    expect(built.owned?.model?.skeletons).toContain(clonedMesh.skeleton);
  });

  it("plays a single clip: clip-local time is (frame / fps) * timeScale, and weight is resolved fresh per frame", () => {
    const entry = fakeLoadedModel({ animations: [positionClip("Move", "x", 10)] });
    const ctx = makeCtxWithModel({ "character.glb": entry });
    // loop: "clamp" here (rather than the "repeat" default): frame 30 lands
    // at exactly rawTime === duration, and a "repeat" clip's own t=0 and
    // t=duration poses are conventionally the same (a seamless loop) - this
    // fixture's own 0-to-10 track is deliberately not seamless, so "clamp"
    // is what actually asserts "played through to the end", unambiguously.
    const node = modelNode({ clips: [{ name: "Move", weight: 1, loop: "clamp" }] });
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 15, built.owned);
    expect(built.object3D.position.x).toBeCloseTo(5);

    applyNodeProperties(node, built.object3D, ctx, 30, built.owned);
    expect(built.object3D.position.x).toBeCloseTo(10);
  });

  it("resolves a keyframed clip weight per frame, muting the clip entirely at weight 0", () => {
    const entry = fakeLoadedModel({ animations: [positionClip("Move", "x", 10)] });
    const ctx = makeCtxWithModel({ "character.glb": entry });
    const node = modelNode({
      clips: [
        {
          name: "Move",
          weight: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] },
          loop: "clamp",
        },
      ],
    });
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    expect(built.object3D.position.x).toBeCloseTo(0);

    applyNodeProperties(node, built.object3D, ctx, 30, built.owned);
    expect(built.object3D.position.x).toBeCloseTo(10);
  });

  it("supports multiple simultaneous clips driving independent properties (blending)", () => {
    const entry = fakeLoadedModel({
      animations: [positionClip("MoveX", "x", 10), positionClip("MoveY", "y", 20)],
    });
    const ctx = makeCtxWithModel({ "character.glb": entry });
    const node = modelNode({
      clips: [
        { name: "MoveX", weight: 1, loop: "clamp" },
        { name: "MoveY", weight: 1, loop: "clamp" },
      ],
    });
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 30, built.owned);

    expect(built.object3D.position.x).toBeCloseTo(10);
    expect(built.object3D.position.y).toBeCloseTo(20);
  });

  it("mutes a loaded clip the current frame's clips array does not reference", () => {
    const entry = fakeLoadedModel({
      animations: [positionClip("MoveX", "x", 10), positionClip("Unused", "x", 999)],
    });
    const ctx = makeCtxWithModel({ "character.glb": entry });
    const node = modelNode({ clips: [{ name: "MoveX", weight: 1, loop: "clamp" }] });
    const built = createThreeObject(node, ctx);

    applyNodeProperties(node, built.object3D, ctx, 30, built.owned);

    expect(built.object3D.position.x).toBeCloseTo(10);
  });

  it("silently ignores a clips entry naming a clip the loaded asset does not have", () => {
    const entry = fakeLoadedModel({ animations: [positionClip("Move", "x", 10)] });
    const ctx = makeCtxWithModel({ "character.glb": entry });
    const node = modelNode({ clips: [{ name: "DoesNotExist", weight: 1 }] });
    const built = createThreeObject(node, ctx);

    expect(() => applyNodeProperties(node, built.object3D, ctx, 15, built.owned)).not.toThrow();
  });

  it("applies timeScale to a clip's own local time", () => {
    const entry = fakeLoadedModel({ animations: [positionClip("Move", "x", 10)] });
    const ctx = makeCtxWithModel({ "character.glb": entry });
    const node = modelNode({ clips: [{ name: "Move", weight: 1, timeScale: 2, loop: "clamp" }] });
    const built = createThreeObject(node, ctx);

    // frame 15 at 30fps = 0.5s raw; * timeScale 2 = 1.0s local time = the clip's own full duration.
    applyNodeProperties(node, built.object3D, ctx, 15, built.owned);
    expect(built.object3D.position.x).toBeCloseTo(10);
  });

  it("clamps past the clip's own duration when loop is 'clamp', and wraps when loop is 'repeat' (the default)", () => {
    const entry = fakeLoadedModel({ animations: [positionClip("Move", "x", 10, 1)] });
    const ctx = makeCtxWithModel({ "character.glb": entry });

    const clamped = modelNode({ clips: [{ name: "Move", weight: 1, loop: "clamp" }] });
    const clampedBuilt = createThreeObject(clamped, ctx);
    applyNodeProperties(clamped, clampedBuilt.object3D, ctx, 45, clampedBuilt.owned);
    expect(clampedBuilt.object3D.position.x).toBeCloseTo(10);

    const repeated = modelNode({ clips: [{ name: "Move", weight: 1, loop: "repeat" }] });
    const repeatedBuilt = createThreeObject(repeated, ctx);
    // frame 45 at 30fps = 1.5s raw; wraps into [0, 1) as 0.5s -> halfway (5).
    applyNodeProperties(repeated, repeatedBuilt.object3D, ctx, 45, repeatedBuilt.owned);
    expect(repeatedBuilt.object3D.position.x).toBeCloseTo(5);
  });

  it("applies keyframed morph target weights by name, across every morph-capable mesh, and ignores an unknown target name", () => {
    const ctx = makeCtxWithModel({ "character.glb": fakeMorphLoadedModel() });
    const node = modelNode({
      morphTargets: {
        smile: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 30, value: 1 }] },
        doesNotExist: 0.5,
      },
    });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D.getObjectByName("Face") as THREE.Mesh;

    applyNodeProperties(node, built.object3D, ctx, 0, built.owned);
    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0);

    applyNodeProperties(node, built.object3D, ctx, 30, built.owned);
    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(1);
    expect(mesh.morphTargetInfluences?.[1]).toBeCloseTo(0);
  });

  it("does not throw applying properties against the not-registered empty group (no owned.model at all)", () => {
    const ctx = makeCtxWithModel({});
    const node = modelNode({ clips: [{ name: "Move", weight: 1 }] });
    const built = createThreeObject(node, ctx);
    expect(() => applyNodeProperties(node, built.object3D, ctx, 5, built.owned)).not.toThrow();
  });
});

/** A mesh node with the given `rigidBody`, at a known, easily-asserted transform. */
function meshNodeWithRigidBody(rigidBody: MeshNode["rigidBody"]): SceneNode {
  return {
    id: "physics-mesh",
    kind: "mesh",
    transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    children: [],
    geometryRef: "box",
    materialRef: "default",
    rigidBody,
  };
}

/** `makeCtx()` plus a `physicsTransforms` lookup pre-populated with `entries`. */
function makeCtxWithPhysics(entries: ReadonlyMap<string, PhysicsTransform>): NodeFactoryContext {
  return { ...makeCtx(), physicsTransforms: entries };
}

describe("node-factory: physics-driven mesh transforms (Phase 66)", () => {
  it("overrides position and rotation for a dynamic body when physicsTransforms has an entry for it", () => {
    const ctx = makeCtxWithPhysics(
      new Map([["physics-mesh", { position: [10, 20, 30], rotation: [0.1, 0.2, 0.3] }]]),
    );
    const node = meshNodeWithRigidBody({ bodyType: "dynamic", collider: { shape: "box", halfExtents: [1, 1, 1] } });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    applyNodeProperties(node, mesh, ctx, 0, built.owned);

    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([10, 20, 30]);
    expect([mesh.rotation.x, mesh.rotation.y, mesh.rotation.z]).toEqual([0.1, 0.2, 0.3]);
  });

  it("falls back to the authored transform when physicsTransforms has no entry for this node id", () => {
    const ctx = makeCtxWithPhysics(new Map([["some-other-node", { position: [10, 20, 30], rotation: [0, 0, 0] }]]));
    const node = meshNodeWithRigidBody({ bodyType: "dynamic", collider: { shape: "box", halfExtents: [1, 1, 1] } });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    applyNodeProperties(node, mesh, ctx, 0, built.owned);

    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([1, 2, 3]);
  });

  it("never overrides a fixed body's transform, even if physicsTransforms happens to have an entry for it", () => {
    const ctx = makeCtxWithPhysics(new Map([["physics-mesh", { position: [10, 20, 30], rotation: [0, 0, 0] }]]));
    const node = meshNodeWithRigidBody({ bodyType: "fixed", collider: { shape: "box", halfExtents: [1, 1, 1] } });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    applyNodeProperties(node, mesh, ctx, 0, built.owned);

    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([1, 2, 3]);
  });

  it("never overrides a kinematic body's transform, even if physicsTransforms happens to have an entry for it", () => {
    const ctx = makeCtxWithPhysics(new Map([["physics-mesh", { position: [10, 20, 30], rotation: [0, 0, 0] }]]));
    const node = meshNodeWithRigidBody({ bodyType: "kinematic", collider: { shape: "box", halfExtents: [1, 1, 1] } });
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    applyNodeProperties(node, mesh, ctx, 0, built.owned);

    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([1, 2, 3]);
  });

  it("does not throw when a dynamic body has rigidBody set but physicsTransforms is entirely omitted", () => {
    const ctx = makeCtx();
    const node = meshNodeWithRigidBody({ bodyType: "dynamic", collider: { shape: "box", halfExtents: [1, 1, 1] } });
    const built = createThreeObject(node, ctx);

    expect(() => applyNodeProperties(node, built.object3D, ctx, 0, built.owned)).not.toThrow();
  });

  it("a mesh with no rigidBody at all ignores physicsTransforms entirely, keeping its own authored transform", () => {
    const ctx = makeCtxWithPhysics(new Map([["physics-mesh", { position: [10, 20, 30], rotation: [0, 0, 0] }]]));
    const node: SceneNode = {
      id: "physics-mesh",
      kind: "mesh",
      transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      children: [],
      geometryRef: "box",
      materialRef: "default",
    };
    const built = createThreeObject(node, ctx);
    const mesh = built.object3D as THREE.Mesh;
    applyNodeProperties(node, mesh, ctx, 0, built.owned);

    expect([mesh.position.x, mesh.position.y, mesh.position.z]).toEqual([1, 2, 3]);
  });

  it("re-applies the current physicsTransforms entry every frame, via applyNodeProperties", () => {
    const node = meshNodeWithRigidBody({ bodyType: "dynamic", collider: { shape: "box", halfExtents: [1, 1, 1] } });
    const ctxAtFrame0 = makeCtxWithPhysics(new Map([["physics-mesh", { position: [1, 0, 0], rotation: [0, 0, 0] }]]));
    const built = createThreeObject(node, ctxAtFrame0);
    const mesh = built.object3D as THREE.Mesh;

    const ctxAtFrame1 = makeCtxWithPhysics(new Map([["physics-mesh", { position: [2, 0, 0], rotation: [0, 0, 0] }]]));
    applyNodeProperties(node, mesh, ctxAtFrame1, 1, built.owned);

    expect(mesh.position.x).toBe(2);
  });
});

/** A light node of the given type, with optional Phase 55 shadow/falloff/area overrides. */
function lightNodeWith(
  lightType: LightType,
  overrides: Omit<
    LightNode,
    "id" | "kind" | "lightType" | "transform" | "visible" | "children" | "color" | "intensity"
  > = {},
): SceneNode {
  return {
    id: "l",
    kind: "light",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    lightType,
    color: [1, 1, 1, 1],
    intensity: 1,
    ...overrides,
  };
}

describe("node-factory: light shadows, falloff, and area lights (Phase 55)", () => {
  it("maps lightType 'area' to a real THREE.RectAreaLight", () => {
    const ctx = makeCtx();
    const built = createThreeObject(lightNodeWith("area"), ctx);
    expect(built.object3D).toBeInstanceOf(THREE.RectAreaLight);
  });

  it("applies width/height to an area light", () => {
    const ctx = makeCtx();
    const node = lightNodeWith("area", { width: 4, height: 2 });
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0);
    const light = built.object3D as THREE.RectAreaLight;
    expect(light.width).toBe(4);
    expect(light.height).toBe(2);
  });

  it("defaults castShadow to false and applies it when set, configuring a directional light's own shadow object", () => {
    const ctx = makeCtx();
    const plain = createThreeObject(lightNodeWith("directional"), ctx).object3D as THREE.DirectionalLight;
    expect(plain.castShadow).toBe(false);

    const node = lightNodeWith("directional", {
      castShadow: true,
      shadow: { mapSize: 2048, bias: -0.0004, radius: 3 },
    });
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0);
    const light = built.object3D as THREE.DirectionalLight;

    expect(light.castShadow).toBe(true);
    expect(light.shadow.mapSize.x).toBe(2048);
    expect(light.shadow.mapSize.y).toBe(2048);
    expect(light.shadow.bias).toBe(-0.0004);
    expect(light.shadow.radius).toBe(3);
  });

  it("does not throw when castShadow is set on an ambient or area light, which have no shadow object at all", () => {
    const ctx = makeCtx();
    for (const lightType of ["ambient", "area"] as const satisfies readonly LightType[]) {
      const node = lightNodeWith(lightType, { castShadow: true, shadow: { mapSize: 1024 } });
      const built = createThreeObject(node, ctx);
      expect(() => applyNodeProperties(node, built.object3D, ctx, 0)).not.toThrow();
      expect(built.object3D.castShadow).toBe(true);
    }
  });

  it("applies distance and decay to point and spot lights", () => {
    const ctx = makeCtx();
    for (const lightType of ["point", "spot"] as const satisfies readonly LightType[]) {
      const node = lightNodeWith(lightType, { distance: 15, decay: 1.5 });
      const built = createThreeObject(node, ctx);
      applyNodeProperties(node, built.object3D, ctx, 0);
      const light = built.object3D as THREE.PointLight | THREE.SpotLight;
      expect(light.distance).toBe(15);
      expect(light.decay).toBe(1.5);
    }
  });

  it("applies angle and penumbra to spot lights only", () => {
    const ctx = makeCtx();
    const node = lightNodeWith("spot", { angle: Math.PI / 8, penumbra: 0.6 });
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0);
    const light = built.object3D as THREE.SpotLight;
    expect(light.angle).toBe(Math.PI / 8);
    expect(light.penumbra).toBe(0.6);
  });

  it("leaves distance/decay/angle/penumbra/width/height at Three.js's own defaults when omitted", () => {
    const ctx = makeCtx();
    const node = lightNodeWith("spot");
    const built = createThreeObject(node, ctx);
    applyNodeProperties(node, built.object3D, ctx, 0);
    const light = built.object3D as THREE.SpotLight;
    // Three.js's own SpotLight constructor defaults, untouched.
    expect(light.distance).toBe(0);
    expect(light.decay).toBe(2);
    expect(light.angle).toBe(Math.PI / 3);
    expect(light.penumbra).toBe(0);
  });
});
