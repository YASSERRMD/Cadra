import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "../scene-graph/primitives.js";
import type {
  TextFill,
  TextGlowConfig,
  TextOutlineConfig,
  TextPathConfig,
  TextShadowConfig,
} from "../scene-graph/scene-node.js";
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
    const path: TextPathConfig = {
      start: [0, 0, 0],
      segments: [{ type: "line", to: [10, 0, 0] }],
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

  it("does not set fill/outline/glow/shadow/variationAxes when omitted", () => {
    const node = Text({ id: "text-1" });

    expect("fill" in node).toBe(false);
    expect("outline" in node).toBe(false);
    expect("glow" in node).toBe(false);
    expect("shadow" in node).toBe(false);
    expect("variationAxes" in node).toBe(false);
  });

  it("sets fill when provided", () => {
    const fill: TextFill = {
      type: "linearGradient",
      stops: [
        { offset: 0, color: [1, 0, 0, 1] },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    };
    const node = Text({ id: "text-1", fill });

    expect(node.fill).toEqual(fill);
  });

  it("sets outline when provided", () => {
    const outline: TextOutlineConfig = { width: 0.05, color: [0, 0, 0, 1] };
    const node = Text({ id: "text-1", outline });

    expect(node.outline).toEqual(outline);
  });

  it("sets glow when provided", () => {
    const glow: TextGlowConfig = { direction: "outer", radius: 0.2, color: [1, 1, 0, 1] };
    const node = Text({ id: "text-1", glow });

    expect(node.glow).toEqual(glow);
  });

  it("sets shadow when provided", () => {
    const shadow: TextShadowConfig = { offsetX: 0.05, offsetY: 0.05, color: [0, 0, 0, 0.5] };
    const node = Text({ id: "text-1", shadow });

    expect(node.shadow).toEqual(shadow);
  });

  it("sets variationAxes when provided", () => {
    const node = Text({ id: "text-1", variationAxes: { wght: 700 } });

    expect(node.variationAxes).toEqual({ wght: 700 });
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
