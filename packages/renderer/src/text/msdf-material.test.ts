import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createMsdfTextMaterial } from "./msdf-material.js";

function fakeAtlasTexture(): THREE.Texture {
  return new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
}

describe("createMsdfTextMaterial: solid fill (default)", () => {
  it("builds a transparent, double-sided, depth-write-disabled material", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture());
    expect(handle.material.transparent).toBe(true);
    expect(handle.material.depthWrite).toBe(false);
    expect(handle.material.side).toBe(THREE.DoubleSide);
  });

  it("does not throw on setColor/setOpacity/setBlur", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture());
    expect(() => handle.setColor(1, 0, 0, 1)).not.toThrow();
    expect(() => handle.setOpacity(0.5)).not.toThrow();
    expect(() => handle.setBlur(0.02)).not.toThrow();
  });

  it("throws if setGradient/setOutline/setGlow are called without being configured for them", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture());
    expect(() => handle.setGradient(0, [[1, 0, 0, 1], [0, 0, 1, 1]])).toThrow();
    expect(() => handle.setOutline(0.05, 0, 0, 0, 1)).toThrow();
    expect(() => handle.setGlow(0.1, 1, 1, 0, 1, 1)).toThrow();
  });
});

describe("createMsdfTextMaterial: linearGradient fill", () => {
  it("builds successfully with 2 or more stops and accepts setGradient", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), {
      fillType: "linearGradient",
      gradientStopOffsets: [0, 0.5, 1],
    });
    expect(() =>
      handle.setGradient(45, [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0, 1, 1],
      ]),
    ).not.toThrow();
  });

  it("throws at build time with fewer than 2 stops", () => {
    expect(() =>
      createMsdfTextMaterial(fakeAtlasTexture(), { fillType: "linearGradient", gradientStopOffsets: [0.5] }),
    ).toThrow();
  });

  it("throws from setGradient when given the wrong number of stop colors", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), {
      fillType: "linearGradient",
      gradientStopOffsets: [0, 1],
    });
    expect(() => handle.setGradient(0, [[1, 1, 1, 1]])).toThrow();
  });

  it("still throws setOutline/setGlow when only a gradient was configured", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), {
      fillType: "linearGradient",
      gradientStopOffsets: [0, 1],
    });
    expect(() => handle.setOutline(0.05, 0, 0, 0, 1)).toThrow();
    expect(() => handle.setGlow(0.1, 1, 1, 0, 1, 1)).toThrow();
  });
});

describe("createMsdfTextMaterial: radialGradient fill", () => {
  it("builds successfully and accepts setGradient, with no angle concept needed", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), {
      fillType: "radialGradient",
      gradientStopOffsets: [0, 1],
    });
    expect(() =>
      handle.setGradient(0, [
        [1, 1, 1, 1],
        [0, 0, 0, 1],
      ]),
    ).not.toThrow();
  });
});

describe("createMsdfTextMaterial: outline", () => {
  it("accepts setOutline when built with outline: true", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), { outline: true });
    expect(() => handle.setOutline(0.08, 0, 0, 0, 1)).not.toThrow();
  });

  it("still throws setGlow when only outline was configured", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), { outline: true });
    expect(() => handle.setGlow(0.1, 1, 1, 0, 1, 1)).toThrow();
  });
});

describe("createMsdfTextMaterial: glow", () => {
  it("accepts setGlow with an outer direction", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), { glow: "outer" });
    expect(() => handle.setGlow(0.15, 1, 1, 0, 1, 1)).not.toThrow();
  });

  it("accepts setGlow with an inner direction", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), { glow: "inner" });
    expect(() => handle.setGlow(0.15, 1, 1, 1, 1, 0.5)).not.toThrow();
  });

  it("still throws setOutline when only glow was configured", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), { glow: "outer" });
    expect(() => handle.setOutline(0.05, 0, 0, 0, 1)).toThrow();
  });
});

describe("createMsdfTextMaterial: every effect combined", () => {
  it("builds successfully with gradient, outline, and glow all configured together", () => {
    const handle = createMsdfTextMaterial(fakeAtlasTexture(), {
      fillType: "linearGradient",
      gradientStopOffsets: [0, 1],
      outline: true,
      glow: "outer",
    });
    expect(() =>
      handle.setGradient(90, [
        [1, 0, 0, 1],
        [0, 0, 1, 1],
      ]),
    ).not.toThrow();
    expect(() => handle.setOutline(0.05, 0, 0, 0, 1)).not.toThrow();
    expect(() => handle.setGlow(0.1, 1, 1, 1, 1, 1)).not.toThrow();
    expect(() => handle.setOpacity(0.8)).not.toThrow();
  });
});
