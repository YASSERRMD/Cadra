import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createDefaultLutRegistry, DEFAULT_LUT_REFS } from "./lut-registry.js";

describe("createDefaultLutRegistry", () => {
  it("resolves every ref in DEFAULT_LUT_REFS to a real Data3DTexture", () => {
    const registry = createDefaultLutRegistry();
    for (const ref of DEFAULT_LUT_REFS) {
      expect(registry.resolve(ref)).toBeInstanceOf(THREE.Data3DTexture);
    }
  });

  it("returns undefined for an unregistered ref", () => {
    const registry = createDefaultLutRegistry();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
  });

  it("returns the exact same instance across repeated resolves of the same ref", () => {
    const registry = createDefaultLutRegistry();
    expect(registry.resolve("warm")).toBe(registry.resolve("warm"));
  });

  it("gives each registry instance its own textures, not shared across registries", () => {
    const registryA = createDefaultLutRegistry();
    const registryB = createDefaultLutRegistry();
    expect(registryA.resolve("warm")).not.toBe(registryB.resolve("warm"));
  });

  it("builds a cube grid: width, height, and depth all equal", () => {
    const registry = createDefaultLutRegistry();
    for (const ref of DEFAULT_LUT_REFS) {
      const texture = registry.resolve(ref) as THREE.Data3DTexture;
      expect(texture.image.width).toBe(texture.image.height);
      expect(texture.image.height).toBe(texture.image.depth);
    }
  });

  it("maps a neutral gray input to something close to itself for every built-in LUT (a subtle look, not a drastic one)", () => {
    const registry = createDefaultLutRegistry();
    for (const ref of DEFAULT_LUT_REFS) {
      const texture = registry.resolve(ref) as THREE.Data3DTexture;
      const size = texture.image.width;
      const mid = Math.floor(size / 2);
      const data = texture.image.data as Uint8Array;
      const index = ((mid * size + mid) * size + mid) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = data[index + channel] as number;
        expect(value, `${ref} channel ${channel}`).toBeGreaterThan(64);
        expect(value, `${ref} channel ${channel}`).toBeLessThan(220);
      }
    }
  });

  it("is deterministic: two fresh registries produce byte-identical pixel data for the same ref", () => {
    const first = createDefaultLutRegistry().resolve("tealOrange") as THREE.Data3DTexture;
    const second = createDefaultLutRegistry().resolve("tealOrange") as THREE.Data3DTexture;

    expect(Array.from(second.image.data as Uint8Array)).toEqual(Array.from(first.image.data as Uint8Array));
  });

  it("produces non-uniform pixel data (a real look transform, not a flat placeholder)", () => {
    const registry = createDefaultLutRegistry();
    for (const ref of DEFAULT_LUT_REFS) {
      const texture = registry.resolve(ref) as THREE.Data3DTexture;
      const data = texture.image.data as Uint8Array;
      const firstTexelR = data[0] as number;
      const lastTexelR = data[data.length - 4] as number;
      expect(lastTexelR, ref).not.toBe(firstTexelR);
    }
  });
});
