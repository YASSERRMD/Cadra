import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createDefaultEnvironmentRegistry, DEFAULT_ENVIRONMENT_REFS } from "./environment-registry.js";

describe("createDefaultEnvironmentRegistry", () => {
  it("resolves every ref in DEFAULT_ENVIRONMENT_REFS to a real DataTexture", () => {
    const registry = createDefaultEnvironmentRegistry();
    for (const ref of DEFAULT_ENVIRONMENT_REFS) {
      expect(registry.resolve(ref)).toBeInstanceOf(THREE.DataTexture);
    }
  });

  it("returns undefined for an unregistered ref", () => {
    const registry = createDefaultEnvironmentRegistry();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
  });

  it("returns the exact same instance across repeated resolves of the same ref", () => {
    const registry = createDefaultEnvironmentRegistry();
    expect(registry.resolve("studio")).toBe(registry.resolve("studio"));
  });

  it("gives each registry instance its own textures, not shared across registries", () => {
    const registryA = createDefaultEnvironmentRegistry();
    const registryB = createDefaultEnvironmentRegistry();
    expect(registryA.resolve("studio")).not.toBe(registryB.resolve("studio"));
  });

  it("sets EquirectangularReflectionMapping on every built-in environment", () => {
    const registry = createDefaultEnvironmentRegistry();
    for (const ref of DEFAULT_ENVIRONMENT_REFS) {
      expect(registry.resolve(ref)?.mapping).toBe(THREE.EquirectangularReflectionMapping);
    }
  });

  it("produces non-uniform pixel data (a real gradient, not a flat placeholder color)", () => {
    const registry = createDefaultEnvironmentRegistry();
    for (const ref of DEFAULT_ENVIRONMENT_REFS) {
      const texture = registry.resolve(ref) as THREE.DataTexture;
      const data = texture.image.data as Float32Array;
      const firstPixelR = data[0] as number;
      const lastRowIndex = (texture.image.height - 1) * texture.image.width * 4;
      const lastPixelR = data[lastRowIndex] as number;
      expect(lastPixelR).not.toBe(firstPixelR);
    }
  });

  it("is deterministic: two fresh registries produce byte-identical pixel data for the same ref", () => {
    const first = createDefaultEnvironmentRegistry().resolve("outdoor") as THREE.DataTexture;
    const second = createDefaultEnvironmentRegistry().resolve("outdoor") as THREE.DataTexture;

    expect(Array.from(second.image.data as Float32Array)).toEqual(Array.from(first.image.data as Float32Array));
  });

  it("keeps every pixel channel finite and non-negative (a physically valid light value)", () => {
    const registry = createDefaultEnvironmentRegistry();
    for (const ref of DEFAULT_ENVIRONMENT_REFS) {
      const texture = registry.resolve(ref) as THREE.DataTexture;
      const data = texture.image.data as Float32Array;
      for (const value of data) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
