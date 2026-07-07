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

  it("does not set physics when omitted", () => {
    const node = Text({ id: "text-1" });

    expect("physics" in node).toBe(false);
  });

  it("sets physics when provided", () => {
    const physics = { effect: "jitter" as const, grouping: "character" as const, positionAmplitude: 0.05 };
    const node = Text({ id: "text-1", physics });

    expect(node.physics).toEqual(physics);
  });

  it("does not set path when omitted", () => {
    const node = Text({ id: "text-1" });

    expect("path" in node).toBe(false);
  });

  it("sets path when provided", () => {
    const path = {
      start: [0, 0, 0] as const,
      segments: [{ type: "line" as const, to: [10, 0, 0] as const }],
    };
    const node = Text({ id: "text-1", path });

    expect(node.path).toEqual(path);
  });

  it("does not set morph when omitted", () => {
    const node = Text({ id: "text-1" });

    expect("morph" in node).toBe(false);
  });

  it("sets morph when provided", () => {
    const morph = { from: "Hello", grouping: "character" as const, progress: 0.5 };
    const node = Text({ id: "text-1", morph });

    expect(node.morph).toEqual(morph);
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
