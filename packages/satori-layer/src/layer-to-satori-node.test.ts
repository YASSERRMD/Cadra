import { describe, expect, it } from "vitest";

import type { LayerElement } from "./layer-element.js";
import { layerElementToSatoriNode } from "./layer-to-satori-node.js";

describe("layerElementToSatoriNode", () => {
  it("carries type and style straight through", () => {
    const element: LayerElement = { type: "div", style: { color: "red" } };
    expect(layerElementToSatoriNode(element)).toEqual({
      type: "div",
      props: { style: { color: "red" } },
    });
  });

  it("unwraps a single string child, matching how JSX itself compiles one", () => {
    const element: LayerElement = { type: "span", children: ["hello"] };
    const node = layerElementToSatoriNode(element);
    expect(node.props["children"]).toBe("hello");
  });

  it("keeps multiple children as an array, converting nested elements recursively", () => {
    const element: LayerElement = {
      type: "div",
      children: ["a", { type: "span", children: ["b"] }],
    };
    const node = layerElementToSatoriNode(element);
    expect(node.props["children"]).toEqual([
      "a",
      { type: "span", props: { children: "b" } },
    ]);
  });

  it("omits the style prop entirely when the element has none, rather than an empty object", () => {
    const node = layerElementToSatoriNode({ type: "div" });
    expect("style" in node.props).toBe(false);
  });

  it("maps img's src/width/height to props directly, ignoring any children field", () => {
    const element: LayerElement = {
      type: "img",
      src: "data:image/png;base64,AAA",
      width: 40,
      height: 20,
    };
    expect(layerElementToSatoriNode(element)).toEqual({
      type: "img",
      props: { src: "data:image/png;base64,AAA", width: 40, height: 20 },
    });
  });

  it("passes through lang for locale-specific text shaping", () => {
    const node = layerElementToSatoriNode({ type: "span", lang: "ja-JP", children: ["骨"] });
    expect(node.props["lang"]).toBe("ja-JP");
  });
});
