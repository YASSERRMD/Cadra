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
    const kinds = ["group", "mesh", "camera", "light", "text", "image", "compositionRef"];
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
});

describe("sceneNodeSchema: image", () => {
  it("accepts an image node with assetRef", () => {
    const result = sceneNodeSchema.safeParse({ ...baseFields(), kind: "image", assetRef: "img-1" });
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
