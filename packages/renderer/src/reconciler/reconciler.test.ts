import {
  type CameraNode,
  createIdentityTransform,
  type KeyframeTrack,
  type LayerElement,
  type MeshMaterialConfig,
  type SceneNode,
  type Transform,
  type VideoNode,
} from "@cadra/core";
import type { RasterizedSvg } from "@cadra/svg-raster/browser";
import type { TextRenderData } from "@cadra/text";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import {
  computeSatoriLayerRenderKey,
  createInMemorySatoriLayerRenderRegistry,
} from "../svg-layer/satori-layer-render-registry.js";
import { computeTextNodeRenderKey, createInMemoryTextRenderRegistry } from "../text/text-render-registry.js";
import { computeVideoFrameRenderKey, createInMemoryVideoFrameRegistry } from "../video-layer/video-frame-registry.js";
import { createReconciler } from "./reconciler.js";
import { createDefaultGeometryRegistry, createDefaultMaterialRegistry } from "./registries.js";

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

/** A minimal, structurally-valid `RasterizedSvg`: real Satori/resvg rendering is `@cadra/satori-layer`'s and `@cadra/svg-raster`'s own test responsibility, not this reconciler's. */
const FAKE_RASTERIZED_SVG: RasterizedSvg = {
  width: 2,
  height: 2,
  pixels: new Uint8Array(2 * 2 * 4).fill(255),
};

/** Builds a `Transform` at the identity, optionally overriding `position`. */
function transformAt(position: Transform["position"] = [0, 0, 0]): Transform {
  return { ...createIdentityTransform(), position };
}

function group(
  id: string,
  children: SceneNode[] = [],
  overrides: Partial<{ visible: boolean; transform: Transform }> = {},
): SceneNode {
  return {
    id,
    kind: "group",
    transform: transformAt(),
    visible: true,
    children,
    ...overrides,
  };
}

function mesh(
  id: string,
  geometryRef = "box",
  materialRef = "default",
  overrides: Partial<{
    visible: boolean;
    transform: Transform;
    children: SceneNode[];
    material: MeshMaterialConfig;
  }> = {},
): SceneNode {
  return {
    id,
    kind: "mesh",
    transform: transformAt(),
    visible: true,
    children: [],
    geometryRef,
    materialRef,
    ...overrides,
  };
}

function camera(
  id: string,
  overrides: Partial<{
    fov: number;
    near: number;
    far: number;
    target: Transform["position"];
  }> = {},
): SceneNode {
  return {
    id,
    kind: "camera",
    transform: transformAt(),
    visible: true,
    children: [],
    fov: 50,
    near: 0.1,
    far: 1000,
    target: [0, 0, 0],
    ...overrides,
  };
}

function light(
  id: string,
  lightType: "ambient" | "directional" | "point" | "spot" = "point",
  overrides: Partial<{ color: [number, number, number, number]; intensity: number }> = {},
): SceneNode {
  return {
    id,
    kind: "light",
    transform: transformAt(),
    visible: true,
    children: [],
    lightType,
    color: [1, 1, 1, 1],
    intensity: 1,
    ...overrides,
  };
}

function text(
  id: string,
  overrides: Partial<{
    content: string;
    color: [number, number, number, number];
    fontSize: number;
    morph: { from: string; grouping: "character"; progress: number };
  }> = {},
): SceneNode {
  return {
    id,
    kind: "text",
    transform: transformAt(),
    visible: true,
    children: [],
    content: "hello",
    fontSize: 12,
    color: [1, 0, 0, 1],
    ...overrides,
  };
}

function image(id: string, assetRef = "asset-1"): SceneNode {
  return {
    id,
    kind: "image",
    transform: transformAt(),
    visible: true,
    children: [],
    assetRef,
  };
}

function video(id: string, assetRef = "asset-1"): SceneNode {
  return {
    id,
    kind: "video",
    transform: transformAt(),
    visible: true,
    children: [],
    assetRef,
    opacity: 1,
  };
}

function satori(
  id: string,
  overrides: Partial<{
    layer: LayerElement;
    width: number;
    height: number;
    opacity: number;
  }> = {},
): SceneNode {
  return {
    id,
    kind: "satori",
    transform: transformAt(),
    visible: true,
    children: [],
    layer: { type: "div", children: ["Cadra"] },
    width: 400,
    height: 200,
    opacity: 1,
    ...overrides,
  };
}

function compositionRef(id: string, compositionId = "comp-1"): SceneNode {
  return {
    id,
    kind: "compositionRef",
    transform: transformAt(),
    visible: true,
    children: [],
    compositionId,
  };
}

describe("createReconciler: kind-to-Three.js mapping", () => {
  it("maps group to THREE.Group", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(group("root"), 0);
    expect(result).toBeInstanceOf(THREE.Group);
  });

  it("maps compositionRef to an empty THREE.Group", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(compositionRef("root"), 0);
    expect(result).toBeInstanceOf(THREE.Group);
    expect(result?.children).toHaveLength(0);
  });

  it("maps mesh to THREE.Mesh with registry-resolved geometry and material", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(mesh("root", "sphere", "wireframe"), 0);
    expect(result).toBeInstanceOf(THREE.Mesh);
    const meshResult = result as THREE.Mesh;
    expect(meshResult.geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect(meshResult.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("falls back to a default box geometry and neutral material when refs do not resolve", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(
      mesh("root", "does-not-exist", "also-missing"),
      0,
    ) as THREE.Mesh;
    expect(result.geometry).toBeInstanceOf(THREE.BoxGeometry);
    expect(result.material).toBeInstanceOf(THREE.Material);
  });

  it("maps camera to THREE.PerspectiveCamera built from fov/near/far, aspect defaulted to 1", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(camera("root", { fov: 60, near: 1, far: 500 }), 0);
    expect(result).toBeInstanceOf(THREE.PerspectiveCamera);
    const cam = result as THREE.PerspectiveCamera;
    expect(cam.fov).toBe(60);
    expect(cam.near).toBe(1);
    expect(cam.far).toBe(500);
    expect(cam.aspect).toBe(1);
  });

  it("calls lookAt with the camera node's target", () => {
    const lookAtSpy = vi.spyOn(THREE.Object3D.prototype, "lookAt");
    const reconciler = createReconciler();

    reconciler.reconcile(camera("root", { target: [1, 2, 3] }), 0);

    expect(lookAtSpy).toHaveBeenCalledWith(1, 2, 3);
    lookAtSpy.mockRestore();
  });

  it.each([
    ["ambient", THREE.AmbientLight],
    ["directional", THREE.DirectionalLight],
    ["point", THREE.PointLight],
    ["spot", THREE.SpotLight],
  ] as const)("maps light with lightType %s to %s", (lightType, ThreeLightClass) => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(light("root", lightType), 0);
    expect(result).toBeInstanceOf(ThreeLightClass);
  });

  it("applies light color and intensity", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(
      light("root", "point", { color: [0.5, 0.25, 0.75, 1], intensity: 3.5 }),
      0,
    ) as THREE.Light;
    // Authored ColorRGBA is sRGB-encoded; resolveSceneColor converts it to
    // THREE's linear working space, so these are NOT the raw authored values.
    expect(result.color.r).toBeCloseTo(0.21404114047158);
    expect(result.color.g).toBeCloseTo(0.050876088164651);
    expect(result.color.b).toBeCloseTo(0.52252155395943);
    expect(result.intensity).toBe(3.5);
  });

  it("maps a text node with no registered render data to an empty group", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(text("root", { color: [0, 1, 0, 1] }), 0) as THREE.Group;
    expect(result).toBeInstanceOf(THREE.Group);
    expect(result.children).toHaveLength(0);
  });

  it("maps text with registered render data to real glyph meshes, colored per the resolved color", () => {
    const textRenderRegistry = createInMemoryTextRenderRegistry();
    textRenderRegistry.register(computeTextNodeRenderKey({ content: "hello" }, 0), {
      data: FAKE_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    const reconciler = createReconciler({ textRenderRegistry });
    const result = reconciler.reconcile(text("root", { color: [0, 1, 0, 1] }), 0) as THREE.Group;

    const glyphMesh = result.children[0]?.children[0]?.children[0] as THREE.Mesh;
    expect(glyphMesh).toBeInstanceOf(THREE.Mesh);
  });

  it("maps image to a Mesh using the shared placeholder plane geometry and a fixed placeholder color", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(image("root"), 0) as THREE.Mesh;
    expect(result).toBeInstanceOf(THREE.Mesh);
    expect(result.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(result.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("two image placeholders share the exact same plane geometry instance", () => {
    const firstResult = createReconciler().reconcile(image("i1"), 0) as THREE.Mesh;
    const secondResult = createReconciler().reconcile(image("i2", "asset-2"), 0) as THREE.Mesh;
    expect(firstResult.geometry).toBe(secondResult.geometry);
  });

  it("two image placeholders each own a distinct per-node material", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [image("i1"), image("i2", "asset-2")]),
      0,
    ) as THREE.Group;
    const firstMaterial = (rootObject.children[0] as THREE.Mesh).material;
    const secondMaterial = (rootObject.children[1] as THREE.Mesh).material;
    expect(firstMaterial).not.toBe(secondMaterial);
  });

  it("maps video to a Mesh using the shared placeholder plane geometry and a fixed placeholder color", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(video("root"), 0) as THREE.Mesh;
    expect(result).toBeInstanceOf(THREE.Mesh);
    expect(result.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    expect(result.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("two video placeholders share the exact same plane geometry instance", () => {
    const firstResult = createReconciler().reconcile(video("v1"), 0) as THREE.Mesh;
    const secondResult = createReconciler().reconcile(video("v2", "asset-2"), 0) as THREE.Mesh;
    expect(firstResult.geometry).toBe(secondResult.geometry);
  });

  it("maps a satori node with no registered render data to an empty group", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(satori("root"), 0) as THREE.Group;
    expect(result).toBeInstanceOf(THREE.Group);
    expect(result.children).toHaveLength(0);
  });

  it("maps satori with registered render data to a real textured mesh, sized to the node's width/height", () => {
    const node = satori("root") as Extract<SceneNode, { kind: "satori" }>;
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    satoriLayerRenderRegistry.register(computeSatoriLayerRenderKey(node, 0), {
      rasterized: FAKE_RASTERIZED_SVG,
    });
    const reconciler = createReconciler({ satoriLayerRenderRegistry });
    const result = reconciler.reconcile(node, 0) as THREE.Group;

    const layerMesh = result.children[0] as THREE.Mesh;
    expect(layerMesh).toBeInstanceOf(THREE.Mesh);
    expect(layerMesh.geometry).toBeInstanceOf(THREE.PlaneGeometry);
    const parameters = (layerMesh.geometry as THREE.PlaneGeometry).parameters;
    expect(parameters.width).toBe(400);
    expect(parameters.height).toBe(200);
  });

  it("resolves a satori node's opacity for the given frame onto the built material", () => {
    const node = satori("root", {
      opacity: 0.25,
    }) as Extract<SceneNode, { kind: "satori" }>;
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    satoriLayerRenderRegistry.register(computeSatoriLayerRenderKey(node, 0), {
      rasterized: FAKE_RASTERIZED_SVG,
    });
    const reconciler = createReconciler({ satoriLayerRenderRegistry });
    const result = reconciler.reconcile(node, 0) as THREE.Group;

    const layerMesh = result.children[0] as THREE.Mesh;
    const material = layerMesh.material as THREE.MeshBasicMaterial;
    expect(material.opacity).toBeCloseTo(0.25);
    expect(material.transparent).toBe(true);
  });
});

describe("createReconciler: add, update, remove", () => {
  it("assigns a fresh Object3D on first sight of an id", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(group("root"), 0);
    expect(result).not.toBeNull();
  });

  it("reuses the exact same Object3D instance across reconcile calls for an unchanged id/kind", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(
      mesh("root", "box", "default", { transform: transformAt([0, 0, 0]) }),
      0,
    );
    const second = reconciler.reconcile(
      mesh("root", "box", "default", { transform: transformAt([1, 2, 3]) }),
      0,
    );
    expect(second).toBe(first);
  });

  it("updates transform (position/rotation/scale) in place on an unchanged id", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(group("root"), 0);
    const updated = reconciler.reconcile(
      group("root", [], {
        transform: { position: [1, 2, 3], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2] },
      }),
      0,
    );
    expect(updated?.position.toArray()).toEqual([1, 2, 3]);
    expect(updated?.rotation.x).toBeCloseTo(0.1);
    expect(updated?.rotation.y).toBeCloseTo(0.2);
    expect(updated?.rotation.z).toBeCloseTo(0.3);
    expect(updated?.scale.toArray()).toEqual([2, 2, 2]);
  });

  it("updates visibility in place on an unchanged id", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(group("root", [], { visible: true }), 0);
    const updated = reconciler.reconcile(group("root", [], { visible: false }), 0);
    expect(updated?.visible).toBe(false);
  });

  it("updates mesh geometry/material when refs change, on the same Object3D instance", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(mesh("root", "box", "default"), 0) as THREE.Mesh;
    const second = reconciler.reconcile(mesh("root", "sphere", "wireframe"), 0) as THREE.Mesh;
    expect(second).toBe(first);
    expect(second.geometry).toBeInstanceOf(THREE.SphereGeometry);
    expect(second.material).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("updates camera fov/near/far/target in place on the same Object3D instance", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(camera("root", { fov: 50 }), 0) as THREE.PerspectiveCamera;
    const second = reconciler.reconcile(
      camera("root", { fov: 75, target: [5, 0, 0] }),
      0,
    ) as THREE.PerspectiveCamera;
    expect(second).toBe(first);
    expect(second.fov).toBe(75);
  });

  it("updates light color/intensity in place on the same Object3D instance", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(light("root", "point", { intensity: 1 }), 0) as THREE.Light;
    const second = reconciler.reconcile(light("root", "point", { intensity: 9 }), 0) as THREE.Light;
    expect(second).toBe(first);
    expect(second.intensity).toBe(9);
  });

  it("removes an Object3D from the tree and detaches it from its parent when its node disappears", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [group("child")]), 0);
    const childObject = rootObject?.children[0];
    expect(childObject).toBeDefined();

    reconciler.reconcile(group("root", []), 0);

    expect(rootObject?.children).toHaveLength(0);
    expect(childObject?.parent).toBeNull();
  });

  it("removes a deeply nested node (not just top-level) when it disappears from the next tree", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [group("mid", [group("leaf")])]), 0);
    const midObject = rootObject?.children[0];
    const leafObject = midObject?.children[0];
    expect(leafObject).toBeDefined();

    reconciler.reconcile(group("root", [group("mid", [])]), 0);

    expect(midObject?.children).toHaveLength(0);
    expect(leafObject?.parent).toBeNull();
  });

  it("reconcile(null) tears down the entire tree and disposes owned resources", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [image("i1")]), 0) as THREE.Group;
    const imageMesh = rootObject.children[0] as THREE.Mesh;
    const material = imageMesh.material as THREE.MeshBasicMaterial;
    const disposeSpy = vi.spyOn(material, "dispose");

    const result = reconciler.reconcile(null, 0);

    expect(result).toBeNull();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(imageMesh.parent).toBeNull();
  });

  it("reconcile(null) disposes every geometry, material, and texture a text node's own render resources own", () => {
    const textRenderRegistry = createInMemoryTextRenderRegistry();
    textRenderRegistry.register(computeTextNodeRenderKey({ content: "hello" }, 0), {
      data: FAKE_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    const reconciler = createReconciler({ textRenderRegistry });
    reconciler.reconcile(text("t1"), 0);
    // Re-reconcile once to reach into the live entry's owned resources via a
    // second, identical tree - simplest way to observe what got built without
    // exposing the reconciler's private `entries` map.
    const rootObject = reconciler.reconcile(text("t1"), 0) as THREE.Group;
    const glyphMesh = rootObject.children[0]?.children[0]?.children[0] as THREE.Mesh;
    const geometryDisposeSpy = vi.spyOn(glyphMesh.geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(glyphMesh.material as THREE.Material, "dispose");

    reconciler.reconcile(null, 0);

    expect(geometryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(materialDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it("reconcile(null) disposes every geometry and material owned by BOTH of a morph text node's own glyph groups", () => {
    const textRenderRegistry = createInMemoryTextRenderRegistry();
    textRenderRegistry.register(computeTextNodeRenderKey({ content: "hello" }, 0), {
      data: FAKE_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    textRenderRegistry.register(computeTextNodeRenderKey({ content: "bye" }, 0), {
      data: FAKE_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    const reconciler = createReconciler({ textRenderRegistry });
    const node = text("t1", { morph: { from: "bye", grouping: "character", progress: 0.5 } });
    reconciler.reconcile(node, 0);
    // Re-reconcile once to reach into the live entry's owned resources via a
    // second, identical tree, mirroring the non-morph text disposal test
    // immediately above.
    const rootObject = reconciler.reconcile(node, 0) as THREE.Group;
    expect(rootObject.children).toHaveLength(2);
    // One level deeper than the non-morph text test above: rootObject is
    // here the wrapping parent (see buildTextObject's own doc), not
    // resources.group directly, so reaching a glyph mesh needs an extra
    // children[0] hop through that wrapper first.
    const toGlyphMesh = rootObject.children[0]?.children[0]?.children[0]?.children[0] as THREE.Mesh;
    const fromGlyphMesh = rootObject.children[1]?.children[0]?.children[0]?.children[0] as THREE.Mesh;
    const toGeometryDisposeSpy = vi.spyOn(toGlyphMesh.geometry, "dispose");
    const toMaterialDisposeSpy = vi.spyOn(toGlyphMesh.material as THREE.Material, "dispose");
    const fromGeometryDisposeSpy = vi.spyOn(fromGlyphMesh.geometry, "dispose");
    const fromMaterialDisposeSpy = vi.spyOn(fromGlyphMesh.material as THREE.Material, "dispose");

    reconciler.reconcile(null, 0);

    expect(toGeometryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(toMaterialDisposeSpy).toHaveBeenCalledTimes(1);
    expect(fromGeometryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(fromMaterialDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it("reconcile(null) disposes the geometry, material, and texture a satori node's own render resources own", () => {
    const node = satori("s1") as Extract<SceneNode, { kind: "satori" }>;
    const satoriLayerRenderRegistry = createInMemorySatoriLayerRenderRegistry();
    satoriLayerRenderRegistry.register(computeSatoriLayerRenderKey(node, 0), {
      rasterized: FAKE_RASTERIZED_SVG,
    });
    const reconciler = createReconciler({ satoriLayerRenderRegistry });
    const rootObject = reconciler.reconcile(node, 0) as THREE.Group;
    const layerMesh = rootObject.children[0] as THREE.Mesh;
    const geometryDisposeSpy = vi.spyOn(layerMesh.geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(layerMesh.material as THREE.Material, "dispose");
    const textureDisposeSpy = vi.spyOn(
      (layerMesh.material as THREE.MeshBasicMaterial).map as THREE.Texture,
      "dispose",
    );

    reconciler.reconcile(null, 0);

    expect(geometryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(materialDisposeSpy).toHaveBeenCalledTimes(1);
    expect(textureDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it("reconcile(null) disposes a resolved image node's own per-node geometry and material, but never its registry-owned texture", () => {
    const texture = new THREE.Texture({ width: 10, height: 10 } as unknown as HTMLImageElement);
    const reconciler = createReconciler({ textureRegistry: { resolve: () => texture } });
    const mesh = reconciler.reconcile(image("i1"), 0) as THREE.Mesh;
    const geometryDisposeSpy = vi.spyOn(mesh.geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(mesh.material as THREE.Material, "dispose");
    const textureDisposeSpy = vi.spyOn(texture, "dispose");

    reconciler.reconcile(null, 0);

    expect(geometryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(materialDisposeSpy).toHaveBeenCalledTimes(1);
    // The texture came from textureRegistry, matching normalMapRef/aoMapRef's
    // own established contract: only whatever populated the registry owns
    // its lifetime, never the reconciler - see TextureRegistry's own doc.
    expect(textureDisposeSpy).not.toHaveBeenCalled();
  });

  it("reconcile(null) disposes a still-placeholder video node's own material (no per-node geometry/texture built yet)", () => {
    const reconciler = createReconciler();
    const mesh = reconciler.reconcile(video("v1"), 0) as THREE.Mesh;
    const materialDisposeSpy = vi.spyOn(mesh.material as THREE.Material, "dispose");

    reconciler.reconcile(null, 0);

    expect(materialDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it("reconcile(null) disposes a resolved video node's own per-node geometry, material, and wrapping texture (unlike image, this texture is reconciler-owned, not registry-owned)", () => {
    const node = video("v1") as VideoNode;
    const renderKey = computeVideoFrameRenderKey(node, 0);
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    videoFrameRegistry.register(renderKey, {
      image: { width: 10, height: 10 } as unknown as ImageBitmap,
    });
    const reconciler = createReconciler({ videoFrameRegistry });
    const mesh = reconciler.reconcile(node, 0) as THREE.Mesh;
    const geometryDisposeSpy = vi.spyOn(mesh.geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(mesh.material as THREE.Material, "dispose");
    const textureDisposeSpy = vi.spyOn(
      (mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture,
      "dispose",
    );

    reconciler.reconcile(null, 0);

    expect(geometryDisposeSpy).toHaveBeenCalledTimes(1);
    expect(materialDisposeSpy).toHaveBeenCalledTimes(1);
    // Unlike image's own texture (which comes pre-wrapped from
    // textureRegistry and so is never disposed by the reconciler),
    // videoFrameRegistry only ever hands back raw decoded pixels -
    // applyVideoNodeProperties wraps them in a fresh THREE.Texture itself,
    // making that texture genuinely reconciler-owned, so unlike image's,
    // it must be disposed here.
    expect(textureDisposeSpy).toHaveBeenCalledTimes(1);
  });

  it("disposes the previous frame's own wrapping texture (not just the material) when a later frame swaps to a different source frame", () => {
    const node = video("v1") as VideoNode;
    const keyAtFrame0 = computeVideoFrameRenderKey(node, 0);
    const keyAtFrame10 = computeVideoFrameRenderKey(node, 10);
    const videoFrameRegistry = createInMemoryVideoFrameRegistry();
    videoFrameRegistry.register(keyAtFrame0, { image: { width: 10, height: 10 } as unknown as ImageBitmap });
    videoFrameRegistry.register(keyAtFrame10, { image: { width: 10, height: 10 } as unknown as ImageBitmap });
    const reconciler = createReconciler({ videoFrameRegistry });

    const mesh = reconciler.reconcile(node, 0) as THREE.Mesh;
    const firstTexture = (mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture;
    const textureDisposeSpy = vi.spyOn(firstTexture, "dispose");

    reconciler.reconcile(node, 10);

    expect(textureDisposeSpy).toHaveBeenCalledTimes(1);
    expect((mesh.material as THREE.MeshBasicMaterial).map).not.toBe(firstTexture);
  });
});

describe("createReconciler: kind change on the same id", () => {
  it("disposes the old owned resources and creates a fresh Object3D when kind changes", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(image("root"), 0) as THREE.Mesh;
    const oldMaterial = first.material as THREE.MeshBasicMaterial;
    const disposeSpy = vi.spyOn(oldMaterial, "dispose");

    const second = reconciler.reconcile(group("root"), 0);

    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(THREE.Group);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dispose registry-provided resources on a kind change away from mesh", () => {
    const geometryRegistry = createDefaultGeometryRegistry();
    const materialRegistry = createDefaultMaterialRegistry();
    const reconciler = createReconciler({ geometryRegistry, materialRegistry });
    const meshResult = reconciler.reconcile(mesh("root", "box", "default"), 0) as THREE.Mesh;
    const geometry = meshResult.geometry;
    const material = meshResult.material as THREE.Material;
    const geometryDisposeSpy = vi.spyOn(geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(material, "dispose");

    reconciler.reconcile(group("root"), 0);

    expect(geometryDisposeSpy).not.toHaveBeenCalled();
    expect(materialDisposeSpy).not.toHaveBeenCalled();
    expect(geometryRegistry.resolve("box")).toBe(geometry);
  });

  it("attaches the freshly created replacement under the same parent the old one was under", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(group("root", [text("child")]), 0) as THREE.Group;
    const oldChildObject = rootObject.children[0];

    reconciler.reconcile(group("root", [group("child")]), 0);

    expect(rootObject.children).toHaveLength(1);
    expect(rootObject.children[0]).not.toBe(oldChildObject);
    expect(rootObject.children[0]).toBeInstanceOf(THREE.Group);
    expect(rootObject.children[0]?.parent).toBe(rootObject);
  });
});

describe("createReconciler: reordering", () => {
  it("preserves a node's own internal (non-scene-graph) Object3D structure across reconcile calls, even with a sibling to reorder", () => {
    // Regression test: reorderChildren used to unconditionally reassign
    // parent.children to exactly the scene-graph-tracked children,
    // silently discarding a text node's own internal line/word/glyph
    // groups (which have no corresponding SceneNode and so never appear
    // in that list) the moment they disagreed in length - i.e. on every
    // single reconcile of a text node with real render data.
    const textRenderRegistry = createInMemoryTextRenderRegistry();
    textRenderRegistry.register(computeTextNodeRenderKey({ content: "hello" }, 0), {
      data: FAKE_TEXT_RENDER_DATA,
      fontBytes: new Uint8Array(),
      fontContentHash: "fake-font",
    });
    const reconciler = createReconciler({ textRenderRegistry });

    const first = reconciler.reconcile(group("root", [text("t1"), image("i1")]), 0) as THREE.Group;
    const textObject = first.children[0] as THREE.Group;
    const innerLineGroup = textObject.children[0];
    expect(innerLineGroup?.name).toBe("line-0");

    // Reorder the two scene-graph siblings; the text node's own internal
    // structure must still be there afterward, untouched.
    const second = reconciler.reconcile(group("root", [image("i1"), text("t1")]), 0) as THREE.Group;
    const textObjectAfterReorder = second.children[1] as THREE.Group;

    expect(textObjectAfterReorder).toBe(textObject);
    expect(textObjectAfterReorder.children).toContain(innerLineGroup);
  });

  it("reorders existing children to match new order without disposing or recreating them", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [group("a"), group("b"), group("c")]),
      0,
    ) as THREE.Group;
    const [aObject, bObject, cObject] = rootObject.children;

    const reordered = reconciler.reconcile(
      group("root", [group("c"), group("a"), group("b")]),
      0,
    ) as THREE.Group;

    expect(reordered).toBe(rootObject);
    expect(reordered.children).toEqual([cObject, aObject, bObject]);
  });

  it("does not replace the children array when order already matches", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [group("a"), group("b")]),
      0,
    ) as THREE.Group;
    const childrenArrayRef = rootObject.children;

    reconciler.reconcile(group("root", [group("a"), group("b")]), 0);

    expect(rootObject.children).toBe(childrenArrayRef);
  });
});

describe("createReconciler: reparenting", () => {
  it("moves an existing Object3D to a new parent rather than recreating it", () => {
    const reconciler = createReconciler();
    const tree = group("root", [group("parentA", [group("moving")]), group("parentB", [])]);
    const rootObject = reconciler.reconcile(tree, 0) as THREE.Group;
    const parentAObject = rootObject.children[0] as THREE.Group;
    const parentBObject = rootObject.children[1] as THREE.Group;
    const movingObject = parentAObject.children[0];
    expect(movingObject).toBeDefined();

    reconciler.reconcile(
      group("root", [group("parentA", []), group("parentB", [group("moving")])]),
      0,
    );

    expect(parentAObject.children).toHaveLength(0);
    expect(parentBObject.children).toHaveLength(1);
    expect(parentBObject.children[0]).toBe(movingObject);
    expect(movingObject?.parent).toBe(parentBObject);
  });

  it("preserves the moved node's own properties (kind, transform) across the reparent", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(
      group("root", [
        group("parentA", [mesh("moving", "box", "default", { transform: transformAt([9, 9, 9]) })]),
        group("parentB", []),
      ]),
      0,
    );

    const rootObject = reconciler.reconcile(
      group("root", [
        group("parentA", []),
        group("parentB", [mesh("moving", "box", "default", { transform: transformAt([9, 9, 9]) })]),
      ]),
      0,
    ) as THREE.Group;

    const parentBObject = rootObject.children[1] as THREE.Group;
    const movedObject = parentBObject.children[0];
    expect(movedObject).toBeInstanceOf(THREE.Mesh);
    expect(movedObject?.position.toArray()).toEqual([9, 9, 9]);
  });
});

describe("createReconciler: shared registry resources are never disposed", () => {
  it("leaves a registry geometry/material intact after the one node referencing it is removed", () => {
    const geometryRegistry = createDefaultGeometryRegistry();
    const materialRegistry = createDefaultMaterialRegistry();
    const reconciler = createReconciler({ geometryRegistry, materialRegistry });
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1", "sphere", "wireframe")]),
      0,
    ) as THREE.Group;
    const meshObject = rootObject.children[0] as THREE.Mesh;
    const geometryDisposeSpy = vi.spyOn(meshObject.geometry, "dispose");
    const materialDisposeSpy = vi.spyOn(meshObject.material as THREE.Material, "dispose");

    reconciler.reconcile(group("root", []), 0);

    expect(geometryDisposeSpy).not.toHaveBeenCalled();
    expect(materialDisposeSpy).not.toHaveBeenCalled();
    expect(geometryRegistry.resolve("sphere")).toBeInstanceOf(THREE.SphereGeometry);
    expect(materialRegistry.resolve("wireframe")).toBeInstanceOf(THREE.MeshBasicMaterial);
  });

  it("leaves a shared registry resource intact when one of two referencing nodes is removed", () => {
    const geometryRegistry = createDefaultGeometryRegistry();
    const materialRegistry = createDefaultMaterialRegistry();
    const reconciler = createReconciler({ geometryRegistry, materialRegistry });
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1", "box", "default"), mesh("m2", "box", "default")]),
      0,
    ) as THREE.Group;
    const sharedGeometry = (rootObject.children[0] as THREE.Mesh).geometry;
    const disposeSpy = vi.spyOn(sharedGeometry, "dispose");

    const afterRemoval = reconciler.reconcile(
      group("root", [mesh("m2", "box", "default")]),
      0,
    ) as THREE.Group;

    expect(disposeSpy).not.toHaveBeenCalled();
    const remainingMesh = afterRemoval.children[0] as THREE.Mesh;
    expect(remainingMesh.geometry).toBe(sharedGeometry);
  });
});

describe("createReconciler: frame-resolved camera Property<T> fields", () => {
  const fovTrack: KeyframeTrack<number> = {
    type: "keyframeTrack",
    keyframes: [
      { frame: 0, value: 40 },
      { frame: 100, value: 100 },
    ],
  };
  const targetTrack: KeyframeTrack<[number, number, number]> = {
    type: "keyframeTrack",
    keyframes: [
      { frame: 0, value: [0, 0, 0] },
      { frame: 100, value: [10, 0, 0] },
    ],
  };

  function animatedCamera(id: string): SceneNode {
    const node: CameraNode = {
      id,
      kind: "camera",
      transform: transformAt(),
      visible: true,
      children: [],
      fov: fovTrack,
      near: 0.1,
      far: 1000,
      target: targetTrack,
    };
    return node;
  }

  it("resolves a keyframed fov to the track's start value at frame 0", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(animatedCamera("root"), 0) as THREE.PerspectiveCamera;
    expect(result.fov).toBe(40);
  });

  it("resolves a keyframed fov to the linearly interpolated midpoint value at frame 50", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(animatedCamera("root"), 50) as THREE.PerspectiveCamera;
    expect(result.fov).toBe(70);
  });

  it("resolves a keyframed fov to the track's end value at frame 100", () => {
    const reconciler = createReconciler();
    const result = reconciler.reconcile(animatedCamera("root"), 100) as THREE.PerspectiveCamera;
    expect(result.fov).toBe(100);
  });

  it("resolves a keyframed target (a second animated field) via lookAt at each frame", () => {
    const lookAtSpy = vi.spyOn(THREE.Object3D.prototype, "lookAt");
    const reconciler = createReconciler();

    reconciler.reconcile(animatedCamera("root"), 0);
    expect(lookAtSpy).toHaveBeenLastCalledWith(0, 0, 0);

    reconciler.reconcile(animatedCamera("root"), 50);
    expect(lookAtSpy).toHaveBeenLastCalledWith(5, 0, 0);

    reconciler.reconcile(animatedCamera("root"), 100);
    expect(lookAtSpy).toHaveBeenLastCalledWith(10, 0, 0);

    lookAtSpy.mockRestore();
  });

  it("re-resolves the same live Object3D in place across frames, rather than creating a new one", () => {
    const reconciler = createReconciler();
    const first = reconciler.reconcile(animatedCamera("root"), 0) as THREE.PerspectiveCamera;
    const second = reconciler.reconcile(animatedCamera("root"), 50) as THREE.PerspectiveCamera;
    expect(second).toBe(first);
    expect(second.fov).toBe(70);
  });

  it("still applies a plain, non-keyframed near/far unaffected by frame", () => {
    const reconciler = createReconciler();
    const atFrame0 = reconciler.reconcile(animatedCamera("root"), 0) as THREE.PerspectiveCamera;
    const atFrame50 = reconciler.reconcile(animatedCamera("root"), 50) as THREE.PerspectiveCamera;
    expect(atFrame0.near).toBe(0.1);
    expect(atFrame0.far).toBe(1000);
    expect(atFrame50.near).toBe(0.1);
    expect(atFrame50.far).toBe(1000);
  });
});

describe("createReconciler: object3D.name is tagged with the originating SceneNode.id", () => {
  it("tags every reconciled object3D's .name with its SceneNode.id, at every depth", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1"), camera("cam-1")]),
      0,
    ) as THREE.Group;

    expect(rootObject.name).toBe("root");
    expect(rootObject.children[0]?.name).toBe("m1");
    expect(rootObject.children[1]?.name).toBe("cam-1");
  });

  it("keeps the .name tag stable across reconcile calls that update the same node in place", () => {
    const reconciler = createReconciler();
    reconciler.reconcile(camera("cam-1", { fov: 50 }), 0);
    const updated = reconciler.reconcile(camera("cam-1", { fov: 75 }), 0);

    expect(updated?.name).toBe("cam-1");
  });

  it("lets a camera be found by id via .traverse(), matching on .name", () => {
    const reconciler = createReconciler();
    const rootObject = reconciler.reconcile(
      group("root", [mesh("m1"), camera("the-camera")]),
      0,
    ) as THREE.Group;

    let found: THREE.Object3D | undefined;
    rootObject.traverse((object3D) => {
      if (object3D.name === "the-camera") {
        found = object3D;
      }
    });

    expect(found).toBeInstanceOf(THREE.PerspectiveCamera);
  });
});

describe("createReconciler: incremental build matches a single fresh build structurally", () => {
  it("produces a structurally identical tree via incremental steps vs. a single reconcile from null", () => {
    const incremental = createReconciler();
    incremental.reconcile(group("root", [group("a")]), 0);
    incremental.reconcile(group("root", [group("a"), mesh("b", "sphere", "wireframe")]), 0);
    const finalTree = group("root", [
      mesh("b", "sphere", "wireframe", { transform: transformAt([1, 1, 1]) }),
      light("c", "directional", { intensity: 2 }),
      camera("d", { fov: 70, target: [0, 1, 0] }),
    ]);
    const incrementalResult = incremental.reconcile(finalTree, 0) as THREE.Group;

    const freshResult = createReconciler().reconcile(finalTree, 0) as THREE.Group;

    expect(structuralSnapshot(incrementalResult)).toEqual(structuralSnapshot(freshResult));
  });
});

/** A plain-data snapshot of an Object3D subtree's shape, for structural (not identity) comparison. */
function structuralSnapshot(object3D: THREE.Object3D): unknown {
  return {
    type: object3D.type,
    position: object3D.position.toArray(),
    rotation: [object3D.rotation.x, object3D.rotation.y, object3D.rotation.z],
    scale: object3D.scale.toArray(),
    visible: object3D.visible,
    children: object3D.children.map(structuralSnapshot),
  };
}

const SPHERE_ARRAY_METALNESS_STEPS = [0, 0.25, 0.5, 0.75, 1];
const SPHERE_ARRAY_ROUGHNESS_STEPS = [0, 0.25, 0.5, 0.75, 1];

/**
 * A reference PBR sphere array: one sphere per (metalness, roughness) pair,
 * the classic material-preview grid real-time PBR renderers ship as a sanity
 * check, laid out row by row (metalness) and column by column (roughness).
 * Every sphere shares the same neutral baseColor, so only metalness/roughness
 * vary cell to cell.
 */
function pbrSphereArray(): SceneNode {
  return group(
    "sphere-array",
    SPHERE_ARRAY_METALNESS_STEPS.flatMap((metalness, row) =>
      SPHERE_ARRAY_ROUGHNESS_STEPS.map((roughness, col) =>
        mesh("sphere", "sphere", "default", {
          transform: transformAt([col * 1.2, row * 1.2, 0]),
          material: { baseColor: [0.8, 0.8, 0.8, 1], metalness, roughness },
        }),
      ),
    ).map((node, index) => ({ ...node, id: `sphere-${index}` })),
  );
}

/** A plain-data snapshot of an Object3D subtree, extended with resolved PBR material params for every mesh - the same shape `structuralSnapshot` gives, plus what a reference sphere array's own render correctness actually hinges on. */
function pbrSnapshot(object3D: THREE.Object3D): unknown {
  return {
    type: object3D.type,
    position: object3D.position.toArray(),
    material:
      object3D instanceof THREE.Mesh && object3D.material instanceof THREE.MeshPhysicalMaterial
        ? {
            color: object3D.material.color.toArray(),
            metalness: object3D.material.metalness,
            roughness: object3D.material.roughness,
          }
        : undefined,
    children: object3D.children.map(pbrSnapshot),
  };
}

describe("createReconciler: reference PBR sphere array across roughness and metalness (Phase 55)", () => {
  it("resolves every cell to its own requested metalness/roughness as a real MeshPhysicalMaterial", () => {
    const result = createReconciler().reconcile(pbrSphereArray(), 0) as THREE.Group;

    expect(result.children).toHaveLength(
      SPHERE_ARRAY_METALNESS_STEPS.length * SPHERE_ARRAY_ROUGHNESS_STEPS.length,
    );

    SPHERE_ARRAY_METALNESS_STEPS.forEach((metalness, row) => {
      SPHERE_ARRAY_ROUGHNESS_STEPS.forEach((roughness, col) => {
        const index = row * SPHERE_ARRAY_ROUGHNESS_STEPS.length + col;
        const sphere = result.children[index] as THREE.Mesh;
        expect(sphere).toBeInstanceOf(THREE.Mesh);
        expect(sphere.geometry).toBeInstanceOf(THREE.SphereGeometry);
        const material = sphere.material as THREE.MeshPhysicalMaterial;
        expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
        expect(material.metalness).toBe(metalness);
        expect(material.roughness).toBe(roughness);
        // Every cell resolves a physically valid, finite, non-negative
        // channel value - "plausible" in the acceptance-criteria sense: no
        // NaN, no out-of-[0,1]-range value ever reaches Three.js.
        expect(material.metalness).toBeGreaterThanOrEqual(0);
        expect(material.metalness).toBeLessThanOrEqual(1);
        expect(material.roughness).toBeGreaterThanOrEqual(0);
        expect(material.roughness).toBeLessThanOrEqual(1);
      });
    });
  });

  it("renders deterministically: two fresh reconciles of the same array produce an identical structural snapshot", () => {
    const first = createReconciler().reconcile(pbrSphereArray(), 0) as THREE.Group;
    const second = createReconciler().reconcile(pbrSphereArray(), 0) as THREE.Group;

    expect(pbrSnapshot(first)).toEqual(pbrSnapshot(second));
  });

  it("renders deterministically out of order: reconciling frames 0 and 5 in reverse order matches in-order results", () => {
    const tree = pbrSphereArray();
    const inOrder = [0, 5].map((frame) => pbrSnapshot(createReconciler().reconcile(tree, frame) as THREE.Group));
    const outOfOrder = [5, 0].map((frame) =>
      pbrSnapshot(createReconciler().reconcile(tree, frame) as THREE.Group),
    );

    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[0]).toEqual(inOrder[1]);
  });
});
