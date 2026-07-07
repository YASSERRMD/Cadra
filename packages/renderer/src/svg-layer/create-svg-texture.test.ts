import type { RasterizedSvg } from "@cadra/svg-raster/browser";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createSvgTexture } from "./create-svg-texture.js";

describe("createSvgTexture", () => {
  it("builds a DataTexture with the rasterized pixels, dimensions, and RGBA format", () => {
    const rasterized: RasterizedSvg = {
      width: 4,
      height: 2,
      pixels: new Uint8Array(4 * 2 * 4).fill(200),
    };

    const texture = createSvgTexture(rasterized);

    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture.image.width).toBe(4);
    expect(texture.image.height).toBe(2);
    expect(texture.image.data).toBe(rasterized.pixels);
    expect(texture.format).toBe(THREE.RGBAFormat);
  });

  it("does not flip Y, matching the rasterized buffer's own top-to-bottom row order", () => {
    const rasterized: RasterizedSvg = { width: 2, height: 2, pixels: new Uint8Array(2 * 2 * 4) };
    expect(createSvgTexture(rasterized).flipY).toBe(false);
  });

  it("tags the texture as sRGB, since rasterized SVG pixels are real gamma-encoded color, unlike an MSDF atlas page", () => {
    const rasterized: RasterizedSvg = { width: 2, height: 2, pixels: new Uint8Array(2 * 2 * 4) };
    expect(createSvgTexture(rasterized).colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("marks the texture as needing a GPU upload", () => {
    // `needsUpdate` is write-only in three.js (setting it bumps `version`
    // internally; reading it back is not meaningful - verified empirically
    // against a bare THREE.DataTexture before writing this assertion), so
    // `version` having advanced past its initial `0` is the real,
    // observable proof `createSvgTexture` set it.
    const rasterized: RasterizedSvg = { width: 2, height: 2, pixels: new Uint8Array(2 * 2 * 4) };
    expect(createSvgTexture(rasterized).version).toBeGreaterThan(0);
  });
});
