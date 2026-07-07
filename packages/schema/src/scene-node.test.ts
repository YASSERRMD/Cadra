import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { lightTypeSchema, sceneNodeKindSchema, sceneNodeSchema } from "./scene-node.js";

function baseFields() {
  return {
    id: "node-1",
    transform: createIdentityTransform(),
    visible: true,
    children: [] as unknown[],
  };
}

describe("sceneNodeKindSchema", () => {
  it("accepts every known kind", () => {
    const kinds = [
      "group",
      "mesh",
      "camera",
      "light",
      "text",
      "image",
      "video",
      "compositionRef",
      "satori",
    ];
    for (const kind of kinds) {
      expect(sceneNodeKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it("rejects an unknown kind", () => {
    expect(sceneNodeKindSchema.safeParse("sprite").success).toBe(false);
  });
});

describe("lightTypeSchema", () => {
  it("accepts every known light type", () => {
    for (const lightType of ["ambient", "directional", "point", "spot"]) {
      expect(lightTypeSchema.safeParse(lightType).success).toBe(true);
    }
  });

  it("rejects an unknown light type", () => {
    expect(lightTypeSchema.safeParse("neon").success).toBe(false);
  });
});

describe("sceneNodeSchema: group", () => {
  it("accepts a minimal group node", () => {
    const result = sceneNodeSchema.safeParse({ ...baseFields(), kind: "group" });
    expect(result.success).toBe(true);
  });

  it("accepts a group node with nested children of other kinds", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "group",
      children: [
        {
          id: "child-mesh",
          kind: "mesh",
          transform: createIdentityTransform(),
          visible: true,
          geometryRef: "geo-1",
          materialRef: "mat-1",
          children: [],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: mesh", () => {
  it("accepts a mesh node with geometryRef and materialRef", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "mesh",
      geometryRef: "geo-1",
      materialRef: "mat-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a mesh node missing materialRef", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "mesh",
      geometryRef: "geo-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("sceneNodeSchema: camera", () => {
  it("accepts a camera node with fov, near, far, and target", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "camera",
      fov: 50,
      near: 0.1,
      far: 1000,
      target: [0, 0, 0],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a camera node with a keyframe track for fov", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "camera",
      fov: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 40 },
          { frame: 100, value: 100 },
        ],
      },
      near: 0.1,
      far: 1000,
      target: [0, 0, 0],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a camera node whose fov keyframe track has unordered keyframes, with a precise diagnostic", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "camera",
      fov: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 50, value: 40 },
          { frame: 10, value: 100 },
        ],
      },
      near: 0.1,
      far: 1000,
      target: [0, 0, 0],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("fov.keyframes.1.frame"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/does not come strictly after/);
    }
  });

  it("accepts a camera node with a keyframe track for target (a Vector3 property)", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "camera",
      fov: 50,
      near: 0.1,
      far: 1000,
      target: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [0, 0, 0] },
          { frame: 100, value: [10, 0, 0] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: light", () => {
  it("accepts a light node with a valid lightType and 0-to-1 color", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "light",
      lightType: "point",
      color: [1, 1, 1, 1],
      intensity: 2,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a light node with an invalid lightType", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "light",
      lightType: "neon",
      color: [1, 1, 1, 1],
      intensity: 2,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a light node with a keyframe track for color and intensity (Phase 26)", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "light",
      lightType: "point",
      color: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [0, 0, 0, 1] },
          { frame: 30, value: [1, 1, 1, 1] },
        ],
      },
      intensity: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 30, value: 5 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: text", () => {
  it("accepts a text node without the optional fontRef", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "text",
      content: "Hello",
      fontSize: 24,
      color: [1, 1, 1, 1],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a text node with fontRef present", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "text",
      content: "Hello",
      fontRef: "font-1",
      fontSize: 24,
      color: [1, 1, 1, 1],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a text node with a keyframe track for fontSize and color (Phase 26)", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "text",
      content: "Hello",
      fontSize: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 12 },
          { frame: 20, value: 48 },
        ],
      },
      color: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [1, 0, 0, 1] },
          { frame: 20, value: [0, 0, 1, 1] },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: transform and visible are Property<T> for every node kind (Phase 26)", () => {
  it("accepts a keyframe track for transform.position, transform.rotation, and transform.scale independently", () => {
    const result = sceneNodeSchema.safeParse({
      id: "node-1",
      kind: "mesh",
      transform: {
        position: {
          type: "keyframeTrack",
          keyframes: [
            { frame: 0, value: [0, 0, 0] },
            { frame: 30, value: [10, 0, 0] },
          ],
        },
        rotation: {
          type: "keyframeTrack",
          keyframes: [
            { frame: 0, value: [0, 0, 0] },
            { frame: 30, value: [0, Math.PI, 0] },
          ],
        },
        scale: [1, 1, 1],
      },
      visible: true,
      children: [],
      geometryRef: "geo-1",
      materialRef: "mat-1",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a keyframe track for visible with 'hold' easing", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "group",
      visible: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: true, easing: "hold" },
          { frame: 10, value: false },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a transform whose position keyframe track has unordered keyframes, with a precise diagnostic", () => {
    const result = sceneNodeSchema.safeParse({
      id: "node-1",
      kind: "group",
      transform: {
        position: {
          type: "keyframeTrack",
          keyframes: [
            { frame: 20, value: [0, 0, 0] },
            { frame: 5, value: [1, 1, 1] },
          ],
        },
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      visible: true,
      children: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("transform.position.keyframes.1.frame"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/does not come strictly after/);
    }
  });
});

describe("sceneNodeSchema: image", () => {
  it("accepts an image node with assetRef", () => {
    const result = sceneNodeSchema.safeParse({ ...baseFields(), kind: "image", assetRef: "img-1" });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: video", () => {
  it("accepts a minimal video node with only assetRef and opacity", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      opacity: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a video node with every optional field given", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      inFrame: 10,
      outFrame: 100,
      playbackRate: 2,
      fitMode: "contain",
      outOfRangeBehavior: "loop",
      opacity: 0.5,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a video node with a keyframe track for opacity", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      opacity: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 30, value: 1 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a video node missing assetRef", () => {
    const result = sceneNodeSchema.safeParse({ ...baseFields(), kind: "video", opacity: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects a video node missing opacity", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid fitMode", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      fitMode: "stretch",
      opacity: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid outOfRangeBehavior", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      outOfRangeBehavior: "freeze",
      opacity: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive playbackRate", () => {
    for (const playbackRate of [0, -1]) {
      const result = sceneNodeSchema.safeParse({
        ...baseFields(),
        kind: "video",
        assetRef: "clip-1",
        playbackRate,
        opacity: 1,
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts outFrame strictly greater than inFrame", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      inFrame: 10,
      outFrame: 11,
      opacity: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects outFrame equal to inFrame, with a precise diagnostic", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      inFrame: 10,
      outFrame: 10,
      opacity: 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("outFrame"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/must be greater than inFrame/);
    }
  });

  it("rejects outFrame less than inFrame", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      inFrame: 10,
      outFrame: 5,
      opacity: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts inFrame alone, without outFrame", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      inFrame: 10,
      opacity: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts outFrame alone, without inFrame", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "video",
      assetRef: "clip-1",
      outFrame: 100,
      opacity: 1,
    });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: compositionRef", () => {
  it("accepts a compositionRef node with compositionId", () => {
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "compositionRef",
      compositionId: "comp-2",
    });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: satori", () => {
  function minimalSatoriFields() {
    return {
      ...baseFields(),
      kind: "satori" as const,
      layer: { type: "div" as const, children: ["Hello"] },
      width: 400,
      height: 200,
      opacity: 1,
    };
  }

  it("accepts a minimal satori node", () => {
    const result = sceneNodeSchema.safeParse(minimalSatoriFields());
    expect(result.success).toBe(true);
  });

  it("accepts a satori node with a nested, styled layer tree, fonts, and element animations", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      layer: {
        type: "div",
        style: {
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#111827",
          borderRadius: 16,
        },
        children: [
          {
            id: "title",
            type: "span",
            style: { fontFamily: "Inter", fontWeight: 700, fontSize: 32, color: "white" },
            children: ["Cadra"],
          },
          { type: "img", src: "data:image/png;base64,AAA", width: 40, height: 40 },
        ],
      },
      fonts: [{ family: "Inter", fontRef: "inter-bold", weight: 700, variationCoordinates: { wght: 700 } }],
      elementAnimations: {
        title: { opacity: 0.5, x: 10, y: -5, color: [1, 1, 1, 1] },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a satori node with a keyframe track for opacity", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      opacity: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: 0 },
          { frame: 30, value: 1 },
        ],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts every known blendMode", () => {
    for (const blendMode of ["normal", "add", "multiply", "screen"]) {
      const result = sceneNodeSchema.safeParse({ ...minimalSatoriFields(), blendMode });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown blendMode", () => {
    const result = sceneNodeSchema.safeParse({ ...minimalSatoriFields(), blendMode: "darken" });
    expect(result.success).toBe(false);
  });

  it("rejects a satori node missing layer, width, height, or opacity", () => {
    const fields = minimalSatoriFields();
    for (const omit of ["layer", "width", "height", "opacity"] as const) {
      const { [omit]: _omitted, ...rest } = fields;
      expect(sceneNodeSchema.safeParse(rest).success).toBe(false);
    }
  });

  it("rejects an unsupported layer element type", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      layer: { type: "h1", children: ["Cadra"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported style value, with a diagnostic pointing at the offending path", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      layer: { type: "div", style: { display: "grid" } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("layer.style.display"),
      );
      expect(issue).toBeDefined();
    }
  });

  it("rejects a stray, unrecognized field on the layer element (strict object)", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      layer: { type: "div", unknownField: true, children: ["Hello"] },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a nested layer element with an invalid type, several levels deep", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      layer: {
        type: "div",
        children: [{ type: "div", children: [{ type: "p", children: ["bad"] }] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts an icon layer element with a name, size, and recoloring style", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      layer: {
        type: "div",
        children: [{ type: "icon", icon: "arrow-right", width: 32, height: 32, style: { color: "#ff0000" } }],
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an icon layer element with no explicit width/height/style at all", () => {
    const result = sceneNodeSchema.safeParse({
      ...minimalSatoriFields(),
      layer: { type: "div", children: [{ type: "icon", icon: "arrow-right" }] },
    });
    expect(result.success).toBe(true);
  });
});

describe("sceneNodeSchema: discriminant enforcement", () => {
  it("rejects an unrecognized kind value", () => {
    const result = sceneNodeSchema.safeParse({ ...baseFields(), kind: "sprite" });
    expect(result.success).toBe(false);
  });

  it("rejects a node whose fields belong to a different kind than its own", () => {
    // A "mesh" kind carrying camera-only fields (fov/near/far/target) instead
    // of its own required geometryRef/materialRef.
    const result = sceneNodeSchema.safeParse({
      ...baseFields(),
      kind: "mesh",
      fov: 50,
      near: 0.1,
      far: 1000,
      target: [0, 0, 0],
    });
    expect(result.success).toBe(false);
  });
});
