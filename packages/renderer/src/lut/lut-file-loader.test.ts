import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { LoadLutFromCubeDependencies } from "./lut-file-loader.js";
import { loadLutFromCube, parseCubeLut } from "./lut-file-loader.js";

/**
 * A minimal, real, hand-written `.cube` file: a 2x2x2 identity LUT (every
 * output color equals its own input color). `.cube`'s own documented data
 * order is red varying fastest, then green, then blue - the eight lines
 * below are exactly the eight corners of the unit RGB cube in that order.
 */
function buildMinimalCubeText(): string {
  return [
    "TITLE \"Identity\"",
    "LUT_3D_SIZE 2",
    "0.0 0.0 0.0",
    "1.0 0.0 0.0",
    "0.0 1.0 0.0",
    "1.0 1.0 0.0",
    "0.0 0.0 1.0",
    "1.0 0.0 1.0",
    "0.0 1.0 1.0",
    "1.0 1.0 1.0",
    "",
  ].join("\n");
}

describe("parseCubeLut", () => {
  it("decodes a real minimal .cube file to the correct grid size", () => {
    const texture = parseCubeLut(buildMinimalCubeText());

    expect(texture).toBeInstanceOf(THREE.Data3DTexture);
    expect(texture.image.width).toBe(2);
    expect(texture.image.height).toBe(2);
    expect(texture.image.depth).toBe(2);
  });

  it("decodes an identity LUT's own corners to themselves", () => {
    const texture = parseCubeLut(buildMinimalCubeText());
    const data = texture.image.data as Uint8Array;

    // First entry: (r=0, g=0, b=0) -> black.
    expect(Array.from(data.slice(0, 4))).toEqual([0, 0, 0, 255]);
    // Second entry: (r=1, g=0, b=0) -> pure red.
    expect(Array.from(data.slice(4, 8))).toEqual([255, 0, 0, 255]);
  });

  it("is deterministic: parsing the same text twice produces identical pixel data", () => {
    const text = buildMinimalCubeText();

    const first = parseCubeLut(text);
    const second = parseCubeLut(text);

    expect(Array.from(second.image.data as Uint8Array)).toEqual(Array.from(first.image.data as Uint8Array));
  });
});

describe("loadLutFromCube", () => {
  function createFakeDeps(text: string): LoadLutFromCubeDependencies {
    return { fetchBytes: vi.fn().mockResolvedValue(new TextEncoder().encode(text)) };
  }

  it("calls fetchBytes with the given url", async () => {
    const deps = createFakeDeps(buildMinimalCubeText());

    await loadLutFromCube("https://example.test/warm.cube", deps);

    expect(deps.fetchBytes).toHaveBeenCalledWith("https://example.test/warm.cube");
  });

  it("returns a real decoded texture alongside a content hash of the fetched bytes", async () => {
    const deps = createFakeDeps(buildMinimalCubeText());

    const result = await loadLutFromCube("https://example.test/warm.cube", deps);

    expect(result.texture).toBeInstanceOf(THREE.Data3DTexture);
    expect(result.texture.image.width).toBe(2);
    expect(typeof result.hash).toBe("string");
    expect(result.hash.length).toBeGreaterThan(0);
  });

  it("produces the same hash for two loads of byte-identical content", async () => {
    const text = buildMinimalCubeText();

    const resultA = await loadLutFromCube("https://example.test/a.cube", createFakeDeps(text));
    const resultB = await loadLutFromCube("https://example.test/b.cube", createFakeDeps(text));

    expect(resultA.hash).toBe(resultB.hash);
  });

  it("propagates a fetchBytes rejection", async () => {
    const failure = new Error("network error");
    const deps: LoadLutFromCubeDependencies = { fetchBytes: vi.fn().mockRejectedValue(failure) };

    await expect(loadLutFromCube("https://example.test/a.cube", deps)).rejects.toThrow(failure);
  });
});
