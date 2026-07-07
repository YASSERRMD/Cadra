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

  it("does not set shadow/falloff/area keys when omitted", () => {
    const node = Light({ id: "light-1" });

    expect("castShadow" in node).toBe(false);
    expect("shadow" in node).toBe(false);
    expect("distance" in node).toBe(false);
    expect("decay" in node).toBe(false);
    expect("angle" in node).toBe(false);
    expect("penumbra" in node).toBe(false);
    expect("width" in node).toBe(false);
    expect("height" in node).toBe(false);
  });

  it("applies shadow/falloff/area props when given", () => {
    const node = Light({
      id: "light-1",
      lightType: "spot",
      castShadow: true,
      shadow: { mapSize: 1024, bias: -0.0005, radius: 2 },
      distance: 20,
      decay: 2,
      angle: Math.PI / 6,
      penumbra: 0.3,
    });

    expect(node).toEqual({
      id: "light-1",
      kind: "light",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      lightType: "spot",
      color: [1, 1, 1, 1],
      intensity: 1,
      castShadow: true,
      shadow: { mapSize: 1024, bias: -0.0005, radius: 2 },
      distance: 20,
      decay: 2,
      angle: Math.PI / 6,
      penumbra: 0.3,
    });
  });

  it("applies area light width/height when given", () => {
    const node = Light({ id: "light-1", lightType: "area", width: 4, height: 2 });

    expect(node.width).toBe(4);
    expect(node.height).toBe(2);
  });
});
