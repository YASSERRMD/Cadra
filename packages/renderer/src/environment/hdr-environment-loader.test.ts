import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";

import type { LoadHdrEnvironmentDependencies } from "./hdr-environment-loader.js";
import { loadHdrEnvironment, parseHdrEnvironment } from "./hdr-environment-loader.js";

/**
 * A minimal, hand-built, real Radiance HDR (`.hdr`) file: a 2x2 image using
 * old-style flat (non-RLE) RGBE scanlines, which `HDRLoader` uses whenever a
 * scanline's width is below 8 pixels (the "new RLE" format's own minimum),
 * so this deliberately small fixture needs no RLE decoding at all. Each
 * pixel is 4 raw bytes (R, G, B, shared exponent); `[128, 0, 0, 128]` decodes
 * to a pure red at `mantissa / 256 * 2^(exponent - 128)` = `0.5 * 2^0` =
 * `0.5`, `[0, 0, 0, 0]` is RGBE's own well-known "black" special case.
 * Verified against Three.js's own real `HDRLoader.parse` before being
 * committed here (not hand-derived from the RGBE spec alone): decodes to a
 * 2x2 `Uint16Array` (half-float) of
 * `[14340, 0, 0, 15360,  0, 14340, 0, 15360,  0, 0, 14340, 15360,  0, 0, 0, 15360]`
 * (alpha always the exact half-float bit pattern for `1.0`; the ~14340
 * values are half-float `0.5` after RGBE's own rounding, not exactly
 * `0x3800`/`14336`).
 */
function buildMinimalHdrBytes(): Uint8Array {
  const header = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 2\n";
  const headerBytes = new TextEncoder().encode(header);
  const pixelBytes = new Uint8Array([
    128, 0, 0, 128, // (0,0): R=0.5
    0, 128, 0, 128, // (1,0): G=0.5
    0, 0, 128, 128, // (0,1): B=0.5
    0, 0, 0, 0, // (1,1): black
  ]);
  const bytes = new Uint8Array(headerBytes.length + pixelBytes.length);
  bytes.set(headerBytes, 0);
  bytes.set(pixelBytes, headerBytes.length);
  return bytes;
}

describe("parseHdrEnvironment", () => {
  it("decodes a real minimal Radiance HDR file to the correct width and height", () => {
    const texture = parseHdrEnvironment(buildMinimalHdrBytes());

    expect(texture).toBeInstanceOf(THREE.DataTexture);
    expect(texture.image.width).toBe(2);
    expect(texture.image.height).toBe(2);
  });

  it("decodes real RGBE pixel data to the expected half-float values", () => {
    const texture = parseHdrEnvironment(buildMinimalHdrBytes());

    expect(Array.from(texture.image.data as Uint16Array)).toEqual([
      14340, 0, 0, 15360, 0, 14340, 0, 15360, 0, 0, 14340, 15360, 0, 0, 0, 15360,
    ]);
  });

  it("sets EquirectangularReflectionMapping, ready for PMREM prefiltering", () => {
    const texture = parseHdrEnvironment(buildMinimalHdrBytes());

    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
  });

  it("is deterministic: parsing the same bytes twice produces identical pixel data", () => {
    const bytes = buildMinimalHdrBytes();

    const first = parseHdrEnvironment(bytes);
    const second = parseHdrEnvironment(bytes);

    expect(Array.from(second.image.data as Uint16Array)).toEqual(Array.from(first.image.data as Uint16Array));
  });
});

describe("loadHdrEnvironment", () => {
  function createFakeDeps(bytes: Uint8Array): LoadHdrEnvironmentDependencies {
    return { fetchBytes: vi.fn().mockResolvedValue(bytes) };
  }

  it("calls fetchBytes with the given url", async () => {
    const deps = createFakeDeps(buildMinimalHdrBytes());

    await loadHdrEnvironment("https://example.test/studio.hdr", deps);

    expect(deps.fetchBytes).toHaveBeenCalledWith("https://example.test/studio.hdr");
  });

  it("returns a real decoded texture alongside a content hash of the fetched bytes", async () => {
    const deps = createFakeDeps(buildMinimalHdrBytes());

    const result = await loadHdrEnvironment("https://example.test/studio.hdr", deps);

    expect(result.texture).toBeInstanceOf(THREE.DataTexture);
    expect(result.texture.image.width).toBe(2);
    expect(typeof result.hash).toBe("string");
    expect(result.hash.length).toBeGreaterThan(0);
  });

  it("produces the same hash for two loads of byte-identical content", async () => {
    const bytesA = buildMinimalHdrBytes();
    const bytesB = buildMinimalHdrBytes();

    const resultA = await loadHdrEnvironment("https://example.test/a.hdr", createFakeDeps(bytesA));
    const resultB = await loadHdrEnvironment("https://example.test/b.hdr", createFakeDeps(bytesB));

    expect(resultA.hash).toBe(resultB.hash);
  });

  it("propagates a fetchBytes rejection", async () => {
    const failure = new Error("network error");
    const deps: LoadHdrEnvironmentDependencies = { fetchBytes: vi.fn().mockRejectedValue(failure) };

    await expect(loadHdrEnvironment("https://example.test/a.hdr", deps)).rejects.toThrow(failure);
  });
});
