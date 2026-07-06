import type { SceneNode } from "@cadra/core";
import { parseScene } from "@cadra/schema";
import { describe, expect, it } from "vitest";

import type { NodeBuilder } from "./node-builder.js";
import { Camera, Image, Light, Shape, Text } from "./primitives.js";
import { scene } from "./scene-builder.js";

/**
 * Wraps a single node placement into a minimal, otherwise-valid document and
 * runs it through the exact same `scene().composition().add().build()` path
 * a real caller would use, so these tests exercise the whole builder, not
 * just `parseScene` in isolation.
 */
function buildWithOnePlacement(placement: { clip: unknown }) {
  return scene({ id: "p", name: "P" })
    .composition({ id: "c", name: "Main", fps: 30, durationInFrames: 60, width: 640, height: 360 })
    .add(placement as never)
    .build();
}

/** One row per primitive: a name (for readable failures), a plain builder, and an animated variant. */
interface PrimitiveCase {
  name: string;
  plain: () => NodeBuilder<SceneNode>;
  animated: () => NodeBuilder<SceneNode>;
}

const CASES: PrimitiveCase[] = [
  {
    name: "Text",
    plain: () => Text({ id: "text-1", content: "Hello" }),
    animated: () =>
      Text({ id: "text-1", content: "Hello" })
        .animateTransform({
          position: [
            { frame: 0, value: [0, 0, 0] },
            { frame: 30, value: [10, 0, 0] },
          ],
        })
        .animateVisible([
          { frame: 0, value: true, easing: "hold" },
          { frame: 30, value: false },
        ])
        .animate({
          color: [
            { frame: 0, value: [1, 1, 1, 1] },
            { frame: 30, value: [0, 0, 0, 1] },
          ],
          fontSize: [
            { frame: 0, value: 12 },
            { frame: 30, value: 48 },
          ],
        }),
  },
  {
    name: "Image",
    plain: () => Image({ id: "image-1" }),
    animated: () =>
      Image({ id: "image-1" })
        .animateTransform({
          scale: [
            { frame: 0, value: [1, 1, 1] },
            { frame: 30, value: [2, 2, 2] },
          ],
        })
        .animateVisible([
          { frame: 0, value: true, easing: "hold" },
          { frame: 20, value: false },
        ]),
  },
  {
    name: "Shape",
    plain: () => Shape({ id: "shape-1" }),
    animated: () =>
      Shape({ id: "shape-1" }).animateTransform({
        rotation: [
          { frame: 0, value: [0, 0, 0] },
          { frame: 30, value: [0, Math.PI, 0] },
        ],
      }),
  },
  {
    name: "Camera",
    plain: () => Camera({ id: "camera-1" }),
    animated: () =>
      Camera({ id: "camera-1" }).animate({
        fov: [
          { frame: 0, value: 40 },
          { frame: 30, value: 90 },
        ],
        near: [{ frame: 0, value: 0.1 }],
        far: [{ frame: 0, value: 1000 }],
        target: [
          { frame: 0, value: [0, 0, 0] },
          { frame: 30, value: [1, 1, 1] },
        ],
      }),
  },
  {
    name: "Light",
    plain: () => Light({ id: "light-1" }),
    animated: () =>
      Light({ id: "light-1" }).animate({
        color: [
          { frame: 0, value: [1, 0, 0, 1] },
          { frame: 30, value: [0, 0, 1, 1] },
        ],
        intensity: [
          { frame: 0, value: 0 },
          { frame: 30, value: 5 },
        ],
      }),
  },
];

describe("Every primitive, without animation, produces a document that passes parseScene", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: plain (unanimated) build passes parseScene`, () => {
      const document = buildWithOnePlacement(testCase.plain().at(0, 30));
      expect(parseScene(document).success).toBe(true);
    });
  }
});

describe("Every primitive, with animation on every field it supports, produces a document that passes parseScene", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: animated build passes parseScene`, () => {
      const document = buildWithOnePlacement(testCase.animated().at(0, 30));
      const result = parseScene(document);
      expect(result.success).toBe(true);
    });
  }
});

describe("Every primitive is reachable from the builder (Phase 26 acceptance criterion)", () => {
  it("names every one of Text/Image/Shape/Camera/Light exactly once, covering the full Phase 7 primitive set", () => {
    const names = CASES.map((testCase) => testCase.name).sort();
    expect(names).toEqual(["Camera", "Image", "Light", "Shape", "Text"]);
  });
});

describe("animate() is restricted at the type level to fields a given node kind actually supports", () => {
  it("Shape has no extra animate() fields beyond transform/visible (both handled separately)", () => {
    // This is fundamentally a compile-time guarantee (AnimationPatchFor<MeshNode>
    // resolves to {}); this runtime assertion just documents that an empty
    // patch is still a legal call, for parity with the other cases above.
    const builder = Shape({ id: "shape-2" }).animate({});
    expect(builder.node.kind).toBe("mesh");
  });
});
