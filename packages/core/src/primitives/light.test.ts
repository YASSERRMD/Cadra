import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "../scene-graph/primitives.js";
import { Light } from "./light.js";

describe("Light", () => {
  it("applies every default when only id is given", () => {
    const node = Light({ id: "light-1" });

    expect(node).toEqual({
      id: "light-1",
      kind: "light",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      lightType: "directional",
      color: [1, 1, 1, 1],
      intensity: 1,
    });
  });

  it("overrides every default when props are given", () => {
    const node = Light({
      id: "light-1",
      name: "Key Light",
      visible: false,
      lightType: "point",
      color: [1, 0.9, 0.8, 1],
      intensity: 2.5,
    });

    expect(node).toEqual({
      id: "light-1",
      kind: "light",
      name: "Key Light",
      transform: createIdentityTransform(),
      visible: false,
      children: [],
      lightType: "point",
      color: [1, 0.9, 0.8, 1],
      intensity: 2.5,
    });
  });
});
