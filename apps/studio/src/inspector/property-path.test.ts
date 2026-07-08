import type { MeshNode, TextNode } from "@cadra/core";
import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { getPropertyAtPath, setPropertyAtPath } from "./property-path.js";

function buildMeshNode(overrides: Partial<MeshNode> = {}): MeshNode {
  return {
    id: "mesh-1",
    kind: "mesh",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    geometryRef: "box",
    materialRef: "default",
    ...overrides,
  };
}

function buildTextNode(overrides: Partial<TextNode> = {}): TextNode {
  return {
    id: "text-1",
    kind: "text",
    transform: createIdentityTransform(),
    visible: true,
    children: [],
    content: "Hello",
    fontSize: 48,
    color: [1, 1, 1, 1],
    ...overrides,
  };
}

describe("property-path mesh material fields", () => {
  it("reads the documented resolveMeshMaterial default when material is entirely absent", () => {
    const node = buildMeshNode();
    expect(getPropertyAtPath(node, "material.baseColor")).toEqual([0.7, 0.7, 0.7, 1]);
    expect(getPropertyAtPath(node, "material.metalness")).toBe(0);
    expect(getPropertyAtPath(node, "material.roughness")).toBe(0.5);
    expect(getPropertyAtPath(node, "material.ior")).toBe(1.5);
    expect(getPropertyAtPath(node, "material.sheenRoughness")).toBe(1);
    expect(getPropertyAtPath(node, "material.opacity")).toBe(1);
  });

  it("reads the actual field when material is present", () => {
    const node = buildMeshNode({ material: { metalness: 0.9, roughness: 0.1 } });
    expect(getPropertyAtPath(node, "material.metalness")).toBe(0.9);
    expect(getPropertyAtPath(node, "material.roughness")).toBe(0.1);
    expect(getPropertyAtPath(node, "material.baseColor")).toEqual([0.7, 0.7, 0.7, 1]);
  });

  it("creates a material object on first write, without disturbing materialRef", () => {
    const node = buildMeshNode();
    const next = setPropertyAtPath(node, "material.baseColor", [1, 0, 0, 1]) as MeshNode;
    expect(next.material).toEqual({ baseColor: [1, 0, 0, 1] });
    expect(next.materialRef).toBe("default");
    expect(node.material).toBeUndefined();
  });

  it("merges into an existing material, leaving sibling fields untouched", () => {
    const node = buildMeshNode({ material: { metalness: 0.9, roughness: 0.1 } });
    const next = setPropertyAtPath(node, "material.opacity", 0.5) as MeshNode;
    expect(next.material).toEqual({ metalness: 0.9, roughness: 0.1, opacity: 0.5 });
    expect(node.material).toEqual({ metalness: 0.9, roughness: 0.1 });
  });
});

describe("property-path text effect fields", () => {
  it("reads extrudeDepth, defaulting to 0 when absent", () => {
    expect(getPropertyAtPath(buildTextNode(), "extrudeDepth")).toBe(0);
    expect(getPropertyAtPath(buildTextNode({ extrudeDepth: 12 }), "extrudeDepth")).toBe(12);
  });

  it("writes extrudeDepth directly onto the node", () => {
    const next = setPropertyAtPath(buildTextNode(), "extrudeDepth", 8) as TextNode;
    expect(next.extrudeDepth).toBe(8);
  });

  it("reads path.progress/startOffset defaults (1 and 0) when path is absent", () => {
    const node = buildTextNode();
    expect(getPropertyAtPath(node, "path.progress")).toBe(1);
    expect(getPropertyAtPath(node, "path.startOffset")).toBe(0);
  });

  it("constructs a minimal schema-valid path config on first write", () => {
    const next = setPropertyAtPath(buildTextNode(), "path.progress", 0.5) as TextNode;
    expect(next.path?.progress).toBe(0.5);
    expect(next.path?.start).toEqual([0, 0, 0]);
    expect(next.path?.segments).toEqual([{ type: "line", to: [1, 0, 0] }]);
  });

  it("preserves an existing path's curve when only progress is edited", () => {
    const node = buildTextNode({
      path: {
        start: [1, 2, 3],
        segments: [{ type: "line", to: [4, 5, 6] }],
        progress: 0.2,
      },
    });
    const next = setPropertyAtPath(node, "path.startOffset", 0.3) as TextNode;
    expect(next.path?.start).toEqual([1, 2, 3]);
    expect(next.path?.segments).toEqual([{ type: "line", to: [4, 5, 6] }]);
    expect(next.path?.progress).toBe(0.2);
    expect(next.path?.startOffset).toBe(0.3);
  });

  it("reads morph.progress default (0) when morph is absent, and constructs a valid config on write", () => {
    expect(getPropertyAtPath(buildTextNode(), "morph.progress")).toBe(0);
    const next = setPropertyAtPath(buildTextNode(), "morph.progress", 0.7) as TextNode;
    expect(next.morph).toEqual({ from: "", grouping: "character", progress: 0.7 });
  });

  it("reads outline width/color defaults when outline is absent, and merges when present", () => {
    expect(getPropertyAtPath(buildTextNode(), "outline.width")).toBe(0.05);
    expect(getPropertyAtPath(buildTextNode(), "outline.color")).toEqual([0, 0, 0, 1]);

    const node = buildTextNode({ outline: { width: 0.2, color: [1, 1, 0, 1] } });
    const next = setPropertyAtPath(node, "outline.width", 0.4) as TextNode;
    expect(next.outline).toEqual({ width: 0.4, color: [1, 1, 0, 1] });
  });

  it("reads glow radius/color/intensity defaults when glow is absent, and merges when present", () => {
    expect(getPropertyAtPath(buildTextNode(), "glow.radius")).toBe(0.1);
    expect(getPropertyAtPath(buildTextNode(), "glow.color")).toEqual([1, 1, 1, 1]);
    expect(getPropertyAtPath(buildTextNode(), "glow.intensity")).toBe(1);

    const node = buildTextNode({ glow: { radius: 0.3, color: [0, 1, 1, 1], intensity: 0.6 } });
    const next = setPropertyAtPath(node, "glow.intensity", 0.9) as TextNode;
    expect(next.glow).toEqual({ radius: 0.3, color: [0, 1, 1, 1], intensity: 0.9 });
  });

  it("reads shadow offset/blur/color defaults when shadow is absent, and merges when present", () => {
    expect(getPropertyAtPath(buildTextNode(), "shadow.offsetX")).toBe(0.05);
    expect(getPropertyAtPath(buildTextNode(), "shadow.offsetY")).toBe(0.05);
    expect(getPropertyAtPath(buildTextNode(), "shadow.blur")).toBe(0);
    expect(getPropertyAtPath(buildTextNode(), "shadow.color")).toEqual([0, 0, 0, 0.5]);

    const node = buildTextNode({
      shadow: { offsetX: 0.1, offsetY: 0.1, color: [0, 0, 0, 1] },
    });
    const next = setPropertyAtPath(node, "shadow.blur", 0.02) as TextNode;
    expect(next.shadow).toEqual({ offsetX: 0.1, offsetY: 0.1, color: [0, 0, 0, 1], blur: 0.02 });
  });

  it("throws for a path unsupported on this node kind", () => {
    expect(() => getPropertyAtPath(buildTextNode(), "material.baseColor")).toThrow(
      /no animatable property/,
    );
  });
});
