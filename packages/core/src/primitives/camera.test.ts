import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "../scene-graph/primitives.js";
import { Camera } from "./camera.js";

describe("Camera", () => {
  it("applies every default when only id is given", () => {
    const node = Camera({ id: "camera-1" });

    expect(node).toEqual({
      id: "camera-1",
      kind: "camera",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      fov: 50,
      near: 0.1,
      far: 1000,
      target: [0, 0, 0],
    });
  });

  it("overrides every default when props are given", () => {
    const node = Camera({
      id: "camera-1",
      name: "Main Camera",
      visible: false,
      fov: 35,
      near: 1,
      far: 5000,
      target: [1, 2, 3],
    });

    expect(node).toEqual({
      id: "camera-1",
      kind: "camera",
      name: "Main Camera",
      transform: createIdentityTransform(),
      visible: false,
      children: [],
      fov: 35,
      near: 1,
      far: 5000,
      target: [1, 2, 3],
    });
  });
});
