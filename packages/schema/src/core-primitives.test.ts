import {
  Camera,
  createComposition,
  Image,
  Light,
  Sequence,
  Series,
  Shape,
  Text,
} from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  cameraNodeSchema,
  imageNodeSchema,
  lightNodeSchema,
  meshNodeSchema,
  textNodeSchema,
} from "./scene-node.js";
import { clipSchema, compositionSchema } from "./timeline.js";

/**
 * Proves every `@cadra/core` primitive factory's output actually validates
 * against its matching Phase 4 Zod schema: this lives here, not in
 * `packages/core`, so it can import `@cadra/core` freely (this package
 * already depends on it) without `@cadra/core` ever depending back on
 * `@cadra/schema`, which would create a circular package dependency.
 */

describe("Shape output validates against meshNodeSchema", () => {
  it("validates a minimal Shape", () => {
    const result = meshNodeSchema.safeParse(Shape({ id: "shape-1" }));
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it("validates a fully overridden Shape", () => {
    const node = Shape({
      id: "shape-1",
      name: "Cube",
      visible: false,
      geometryRef: "sphere",
      materialRef: "glass",
    });
    expect(meshNodeSchema.safeParse(node).success).toBe(true);
  });
});

describe("Text output validates against textNodeSchema", () => {
  it("validates a minimal Text", () => {
    const result = textNodeSchema.safeParse(Text({ id: "text-1" }));
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it("validates a Text with fontRef present", () => {
    const node = Text({ id: "text-1", content: "Hello", fontRef: "font-1", fontSize: 32 });
    expect(textNodeSchema.safeParse(node).success).toBe(true);
  });
});

describe("Image output validates against imageNodeSchema", () => {
  it("validates a minimal Image", () => {
    const result = imageNodeSchema.safeParse(Image({ id: "image-1" }));
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });
});

describe("Camera output validates against cameraNodeSchema", () => {
  it("validates a minimal Camera", () => {
    const result = cameraNodeSchema.safeParse(Camera({ id: "camera-1" }));
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });
});

describe("Light output validates against lightNodeSchema", () => {
  it("validates a minimal Light", () => {
    const result = lightNodeSchema.safeParse(Light({ id: "light-1" }));
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });
});

describe("Sequence output validates against clipSchema", () => {
  it("validates a Sequence wrapping a single node", () => {
    const clip = Sequence({
      id: "clip-1",
      from: 0,
      durationInFrames: 30,
      content: Shape({ id: "shape-1" }),
    });
    const result = clipSchema.safeParse(clip);
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });

  it("validates a Sequence wrapping multiple nodes in a derived group", () => {
    const clip = Sequence({
      id: "clip-2",
      from: 10,
      durationInFrames: 20,
      content: [Shape({ id: "shape-a" }), Text({ id: "text-a" })],
    });
    const result = clipSchema.safeParse(clip);
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });
});

describe("Series output validates against clipSchema for every produced clip", () => {
  it("validates every clip in a multi-entry Series", () => {
    const clips = Series([
      { id: "clip-1", durationInFrames: 10, content: Shape({ id: "s1" }) },
      { id: "clip-2", durationInFrames: 20, content: Text({ id: "t1" }) },
      { id: "clip-3", durationInFrames: 15, content: Image({ id: "i1" }) },
    ]);

    for (const clip of clips) {
      const result = clipSchema.safeParse(clip);
      expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
    }
  });
});

describe("createComposition output validates against compositionSchema", () => {
  it("validates a minimal Composition", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
    });
    const result = compositionSchema.safeParse(composition);
    expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
  });
});
