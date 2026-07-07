import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "../scene-graph/primitives.js";
import { Text } from "./text.js";

describe("Text", () => {
  it("applies every default when only id is given", () => {
    const node = Text({ id: "text-1" });

    expect(node).toEqual({
      id: "text-1",
      kind: "text",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      content: "",
      fontSize: 24,
      color: [1, 1, 1, 1],
    });
  });

  it("does not set fontRef when omitted", () => {
    const node = Text({ id: "text-1" });

    expect("fontRef" in node).toBe(false);
  });

  it("sets fontRef when provided", () => {
    const node = Text({ id: "text-1", fontRef: "font-inter" });

    expect(node.fontRef).toBe("font-inter");
  });

  it("does not set stagger when omitted", () => {
    const node = Text({ id: "text-1" });

    expect("stagger" in node).toBe(false);
  });

  it("sets stagger when provided", () => {
    const stagger = {
      preset: "typewriter" as const,
      grouping: "character" as const,
      startFrame: 0,
      delayFrames: 2,
      durationFrames: 1,
    };
    const node = Text({ id: "text-1", stagger });

    expect(node.stagger).toEqual(stagger);
  });

  it("overrides every default when props are given", () => {
    const node = Text({
      id: "text-1",
      name: "Title",
      visible: false,
      content: "Hello, Cadra",
      fontSize: 48,
      color: [1, 0, 0, 1],
    });

    expect(node).toEqual({
      id: "text-1",
      kind: "text",
      name: "Title",
      transform: createIdentityTransform(),
      visible: false,
      children: [],
      content: "Hello, Cadra",
      fontSize: 48,
      color: [1, 0, 0, 1],
    });
  });
});
