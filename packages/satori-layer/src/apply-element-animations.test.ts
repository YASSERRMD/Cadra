import type { ColorRGBA } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { applyElementAnimations } from "./apply-element-animations.js";
import type { LayerElement } from "./layer-element.js";

describe("applyElementAnimations", () => {
  it("returns the element unchanged when no resolved style targets its id", () => {
    const element: LayerElement = { id: "title", type: "span", children: ["Hi"] };
    expect(applyElementAnimations(element, {})).toEqual(element);
  });

  it("returns an element with no id unchanged, even if resolvedStyles is non-empty", () => {
    const element: LayerElement = { type: "span", children: ["Hi"] };
    expect(applyElementAnimations(element, { title: { opacity: 0.5 } })).toEqual(element);
  });

  it("overrides style.opacity outright for a targeted element", () => {
    const element: LayerElement = { id: "title", type: "span", style: { fontSize: 20 } };
    const result = applyElementAnimations(element, { title: { opacity: 0.5 } });
    expect(result.style?.opacity).toBe(0.5);
    expect(result.style?.fontSize).toBe(20);
  });

  it("sets a translate transform for x/y when the element has no authored transform", () => {
    const element: LayerElement = { id: "title", type: "span" };
    const result = applyElementAnimations(element, { title: { x: 10, y: -5 } });
    expect(result.style?.transform).toBe("translate(10px, -5px)");
  });

  it("defaults an unset x or y to 0 within the translate", () => {
    const element: LayerElement = { id: "title", type: "span" };
    expect(applyElementAnimations(element, { title: { x: 10 } }).style?.transform).toBe(
      "translate(10px, 0px)",
    );
    expect(applyElementAnimations(element, { title: { y: 10 } }).style?.transform).toBe(
      "translate(0px, 10px)",
    );
  });

  it("prepends the translate ahead of an existing authored transform", () => {
    const element: LayerElement = { id: "title", type: "span", style: { transform: "rotate(5deg)" } };
    const result = applyElementAnimations(element, { title: { x: 10, y: 0 } });
    expect(result.style?.transform).toBe("translate(10px, 0px) rotate(5deg)");
  });

  it("converts a resolved color to a straight-alpha CSS rgba() string", () => {
    const element: LayerElement = { id: "title", type: "span" };
    const color: ColorRGBA = [1, 0.5, 0, 0.25];
    const result = applyElementAnimations(element, { title: { color } });
    expect(result.style?.color).toBe("rgba(255, 128, 0, 0.25)");
  });

  it("applies animations recursively to nested elements, leaving string children untouched", () => {
    const layer: LayerElement = {
      type: "div",
      children: [
        "plain text",
        { id: "title", type: "span", children: ["Cadra"] },
        { id: "subtitle", type: "span", children: ["Subtitle"] },
      ],
    };

    const result = applyElementAnimations(layer, {
      title: { opacity: 1 },
      subtitle: { opacity: 0.5, x: 20 },
    });

    expect(result.children?.[0]).toBe("plain text");
    expect((result.children?.[1] as LayerElement).style?.opacity).toBe(1);
    expect((result.children?.[2] as LayerElement).style?.opacity).toBe(0.5);
    expect((result.children?.[2] as LayerElement).style?.transform).toBe("translate(20px, 0px)");
  });

  it("does not mutate the original layer tree", () => {
    const layer: LayerElement = { id: "title", type: "span", style: { fontSize: 20 } };
    const original = JSON.parse(JSON.stringify(layer)) as LayerElement;
    applyElementAnimations(layer, { title: { opacity: 0.5 } });
    expect(layer).toEqual(original);
  });
});
