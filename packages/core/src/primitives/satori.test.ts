import { describe, expect, it } from "vitest";

import type { LayerElement } from "../scene-graph/layer-element.js";
import { createIdentityTransform } from "../scene-graph/primitives.js";
import { Satori } from "./satori.js";

const SIMPLE_LAYER: LayerElement = { type: "div", style: { color: "white" }, children: ["Hello"] };

describe("Satori", () => {
  it("applies every default when only the required props are given", () => {
    const node = Satori({ id: "satori-1", layer: SIMPLE_LAYER, width: 400, height: 200 });

    expect(node).toEqual({
      id: "satori-1",
      kind: "satori",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      layer: SIMPLE_LAYER,
      width: 400,
      height: 200,
      opacity: 1,
    });
  });

  it("overrides every default when props are given", () => {
    const node = Satori({
      id: "satori-1",
      name: "Lower Third",
      visible: false,
      layer: SIMPLE_LAYER,
      width: 800,
      height: 300,
      opacity: 0.5,
      blendMode: "add",
      fonts: [{ family: "Inter", fontRef: "inter-regular", weight: 400 }],
      elementAnimations: { title: { opacity: 1 } },
    });

    expect(node).toEqual({
      id: "satori-1",
      kind: "satori",
      name: "Lower Third",
      transform: createIdentityTransform(),
      visible: false,
      children: [],
      layer: SIMPLE_LAYER,
      width: 800,
      height: 300,
      opacity: 0.5,
      blendMode: "add",
      fonts: [{ family: "Inter", fontRef: "inter-regular", weight: 400 }],
      elementAnimations: { title: { opacity: 1 } },
    });
  });
});
