import { describe, expect, it } from "vitest";

import type { TextFill, TextGlowConfig, TextOutlineConfig, TextShadowConfig } from "../scene-graph/scene-node.js";
import { resolveTextFill, resolveTextGlow, resolveTextOutline, resolveTextShadow } from "./text-material.js";

describe("resolveTextFill: solid", () => {
  it("resolves a plain color", () => {
    const fill: TextFill = { type: "solid", color: [1, 0, 0, 1] };
    expect(resolveTextFill(fill, 0)).toEqual({ type: "solid", color: [1, 0, 0, 1] });
  });

  it("resolves a keyframed color at different frames", () => {
    const fill: TextFill = {
      type: "solid",
      color: {
        type: "keyframeTrack",
        keyframes: [
          { frame: 0, value: [1, 0, 0, 1] },
          { frame: 10, value: [0, 0, 1, 1] },
        ],
      },
    };
    expect(resolveTextFill(fill, 0)).toEqual({ type: "solid", color: [1, 0, 0, 1] });
    expect(resolveTextFill(fill, 10)).toEqual({ type: "solid", color: [0, 0, 1, 1] });
  });
});

describe("resolveTextFill: linearGradient", () => {
  it("defaults angle to 0 and resolves every stop's own color", () => {
    const fill: TextFill = {
      type: "linearGradient",
      stops: [
        { offset: 0, color: [1, 0, 0, 1] },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    };
    const resolved = resolveTextFill(fill, 0);
    expect(resolved).toEqual({
      type: "linearGradient",
      angle: 0,
      stops: [
        { offset: 0, color: [1, 0, 0, 1] },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    });
  });

  it("resolves a keyframed angle", () => {
    const fill: TextFill = {
      type: "linearGradient",
      angle: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 90 }] },
      stops: [
        { offset: 0, color: [1, 1, 1, 1] },
        { offset: 1, color: [0, 0, 0, 1] },
      ],
    };
    expect((resolveTextFill(fill, 0) as { angle: number }).angle).toBe(0);
    expect((resolveTextFill(fill, 10) as { angle: number }).angle).toBe(90);
  });

  it("keeps each stop's own offset unchanged (structural, not resolved)", () => {
    const fill: TextFill = {
      type: "linearGradient",
      stops: [
        { offset: 0.25, color: [1, 0, 0, 1] },
        { offset: 0.75, color: [0, 0, 1, 1] },
      ],
    };
    const resolved = resolveTextFill(fill, 5) as { stops: readonly { offset: number }[] };
    expect(resolved.stops[0]?.offset).toBe(0.25);
    expect(resolved.stops[1]?.offset).toBe(0.75);
  });
});

describe("resolveTextFill: radialGradient", () => {
  it("resolves every stop's own color, with no angle field at all", () => {
    const fill: TextFill = {
      type: "radialGradient",
      stops: [
        { offset: 0, color: [1, 1, 1, 1] },
        { offset: 1, color: [0, 0, 0, 1] },
      ],
    };
    const resolved = resolveTextFill(fill, 0);
    expect(resolved).toEqual({
      type: "radialGradient",
      stops: [
        { offset: 0, color: [1, 1, 1, 1] },
        { offset: 1, color: [0, 0, 0, 1] },
      ],
    });
    expect("angle" in resolved).toBe(false);
  });
});

describe("resolveTextFill: texture and video", () => {
  it("passes assetRef through unchanged for both", () => {
    expect(resolveTextFill({ type: "texture", assetRef: "asset-1" }, 0)).toEqual({
      type: "texture",
      assetRef: "asset-1",
    });
    expect(resolveTextFill({ type: "video", assetRef: "asset-2" }, 0)).toEqual({
      type: "video",
      assetRef: "asset-2",
    });
  });
});

describe("resolveTextFill: determinism", () => {
  it("is deterministic and order-independent across frames for a keyframed gradient", () => {
    const fill: TextFill = {
      type: "linearGradient",
      angle: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 180 }] },
      stops: [
        {
          offset: 0,
          color: { type: "keyframeTrack", keyframes: [{ frame: 0, value: [1, 0, 0, 1] }, { frame: 10, value: [0, 1, 0, 1] }] },
        },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    };
    const resolveAtFrame = (frame: number) => resolveTextFill(fill, frame);

    const first = resolveAtFrame(6);
    const second = resolveAtFrame(6);
    expect(second).toEqual(first);

    const inOrder = [0, 5, 10].map(resolveAtFrame);
    const outOfOrder = [10, 0, 5].map(resolveAtFrame);
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[2]).toEqual(inOrder[1]);
    expect(outOfOrder[0]).toEqual(inOrder[2]);
  });
});

describe("resolveTextOutline", () => {
  it("resolves width and color", () => {
    const config: TextOutlineConfig = { width: 0.05, color: [0, 0, 0, 1] };
    expect(resolveTextOutline(config, 0)).toEqual({ width: 0.05, color: [0, 0, 0, 1] });
  });

  it("is deterministic and order-independent across frames for a keyframed width", () => {
    const config: TextOutlineConfig = {
      width: { type: "keyframeTrack", keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 0.1 }] },
      color: [0, 0, 0, 1],
    };
    const resolveAtFrame = (frame: number) => resolveTextOutline(config, frame);

    const first = resolveAtFrame(3);
    const second = resolveAtFrame(3);
    expect(second).toEqual(first);

    const inOrder = [0, 5, 10].map(resolveAtFrame);
    const outOfOrder = [10, 0, 5].map(resolveAtFrame);
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[2]).toEqual(inOrder[1]);
    expect(outOfOrder[0]).toEqual(inOrder[2]);
  });
});

describe("resolveTextGlow", () => {
  it("defaults direction to outer and intensity to 1", () => {
    const config: TextGlowConfig = { radius: 0.2, color: [1, 1, 0, 1] };
    expect(resolveTextGlow(config, 0)).toEqual({
      direction: "outer",
      radius: 0.2,
      color: [1, 1, 0, 1],
      intensity: 1,
    });
  });

  it("resolves an explicit inner direction and custom intensity", () => {
    const config: TextGlowConfig = { direction: "inner", radius: 0.15, color: [1, 1, 1, 1], intensity: 0.5 };
    expect(resolveTextGlow(config, 0)).toEqual({
      direction: "inner",
      radius: 0.15,
      color: [1, 1, 1, 1],
      intensity: 0.5,
    });
  });
});

describe("resolveTextShadow", () => {
  it("defaults blur to 0 and steps to 1", () => {
    const config: TextShadowConfig = { offsetX: 0.1, offsetY: 0.1, color: [0, 0, 0, 0.5] };
    expect(resolveTextShadow(config, 0)).toEqual({
      offsetX: 0.1,
      offsetY: 0.1,
      blur: 0,
      color: [0, 0, 0, 0.5],
      steps: 1,
    });
  });

  it("resolves an explicit blur and steps for a long shadow", () => {
    const config: TextShadowConfig = { offsetX: 0.05, offsetY: 0.05, blur: 0.02, color: [0, 0, 0, 0.8], steps: 6 };
    expect(resolveTextShadow(config, 0)).toEqual({
      offsetX: 0.05,
      offsetY: 0.05,
      blur: 0.02,
      color: [0, 0, 0, 0.8],
      steps: 6,
    });
  });
});
