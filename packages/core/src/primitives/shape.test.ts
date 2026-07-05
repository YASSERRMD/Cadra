import { describe, expect, it } from "vitest";

import { createIdentityTransform, type Transform } from "../scene-graph/primitives.js";
import { Shape } from "./shape.js";

describe("Shape", () => {
  it("applies every default when only id is given", () => {
    const node = Shape({ id: "shape-1" });

    expect(node).toEqual({
      id: "shape-1",
      kind: "mesh",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      geometryRef: "box",
      materialRef: "default",
    });
  });

  it("does not set a name key when name is omitted", () => {
    const node = Shape({ id: "shape-1" });

    expect("name" in node).toBe(false);
  });

  it("overrides every default when props are given", () => {
    const transform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] };
    const child = Shape({ id: "child" });

    const node = Shape({
      id: "shape-1",
      name: "My Shape",
      transform,
      visible: false,
      children: [child],
      geometryRef: "sphere",
      materialRef: "glass",
    });

    expect(node).toEqual({
      id: "shape-1",
      kind: "mesh",
      name: "My Shape",
      transform,
      visible: false,
      children: [child],
      geometryRef: "sphere",
      materialRef: "glass",
    });
  });

  it("passing visible explicitly overrides the true default", () => {
    expect(Shape({ id: "s", visible: false }).visible).toBe(false);
    expect(Shape({ id: "s", visible: true }).visible).toBe(true);
  });
});
