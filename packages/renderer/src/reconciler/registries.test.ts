import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  createDataTexture,
  createDefaultGeometryRegistry,
  createDefaultMaterialRegistry,
  createDefaultTextureRegistry,
  createImageTexture,
  createInMemoryTextureRegistry,
  DEFAULT_GEOMETRY_REFS,
  DEFAULT_MATERIAL_REFS,
} from "./registries.js";

describe("createDefaultGeometryRegistry", () => {
  it("resolves every ref in DEFAULT_GEOMETRY_REFS to a BufferGeometry", () => {
    const registry = createDefaultGeometryRegistry();
    for (const ref of DEFAULT_GEOMETRY_REFS) {
      expect(registry.resolve(ref)).toBeInstanceOf(THREE.BufferGeometry);
    }
  });

  it("resolves box, sphere, and plane to their specific geometry classes", () => {
    const registry = createDefaultGeometryRegistry();
    expect(registry.resolve("box")).toBeInstanceOf(THREE.BoxGeometry);
    expect(registry.resolve("sphere")).toBeInstanceOf(THREE.SphereGeometry);
    expect(registry.resolve("plane")).toBeInstanceOf(THREE.PlaneGeometry);
  });

  it("returns undefined for an unregistered ref", () => {
    const registry = createDefaultGeometryRegistry();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
  });

  it("returns the exact same instance across repeated resolves of the same ref", () => {
    const registry = createDefaultGeometryRegistry();
    expect(registry.resolve("box")).toBe(registry.resolve("box"));
  });

  it("gives each registry instance its own geometries, not shared across registries", () => {
    const registryA = createDefaultGeometryRegistry();
    const registryB = createDefaultGeometryRegistry();
    expect(registryA.resolve("box")).not.toBe(registryB.resolve("box"));
  });
});

describe("createDefaultMaterialRegistry", () => {
  it("resolves every ref in DEFAULT_MATERIAL_REFS to a Material", () => {
    const registry = createDefaultMaterialRegistry();
    for (const ref of DEFAULT_MATERIAL_REFS) {
      expect(registry.resolve(ref)).toBeInstanceOf(THREE.Material);
    }
  });

  it("returns undefined for an unregistered ref", () => {
    const registry = createDefaultMaterialRegistry();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
  });

  it("returns the exact same instance across repeated resolves of the same ref", () => {
    const registry = createDefaultMaterialRegistry();
    expect(registry.resolve("default")).toBe(registry.resolve("default"));
  });

  it("gives 'default' a cinematic roughness rather than Three.js's own fully-matte default", () => {
    const registry = createDefaultMaterialRegistry();
    const material = registry.resolve("default") as THREE.MeshStandardMaterial;
    expect(material.roughness).toBe(0.7);
  });
});

describe("createDefaultTextureRegistry", () => {
  it("resolves every ref to undefined (the no-registry-injected fallback)", () => {
    const registry = createDefaultTextureRegistry();
    expect(registry.resolve("normal-1")).toBeUndefined();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
  });
});

describe("createInMemoryTextureRegistry", () => {
  it("resolves an unregistered ref to undefined", () => {
    const registry = createInMemoryTextureRegistry();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
  });

  it("resolves a registered ref to the exact texture instance it was registered with", () => {
    const registry = createInMemoryTextureRegistry();
    const texture = new THREE.Texture();
    registry.register("cadra-asset://abc123", texture);
    expect(registry.resolve("cadra-asset://abc123")).toBe(texture);
  });

  it("gives each registry instance its own entries, not shared across registries", () => {
    const registryA = createInMemoryTextureRegistry();
    const registryB = createInMemoryTextureRegistry();
    registryA.register("shared-ref", new THREE.Texture());
    expect(registryB.resolve("shared-ref")).toBeUndefined();
  });
});

describe("createImageTexture", () => {
  function fakeImageBitmap(width: number, height: number): ImageBitmap {
    return { width, height } as unknown as ImageBitmap;
  }

  it("wraps the given ImageBitmap as the texture's own .image", () => {
    const bitmap = fakeImageBitmap(64, 32);
    const texture = createImageTexture(bitmap);
    expect(texture).toBeInstanceOf(THREE.Texture);
    expect(texture.image).toBe(bitmap);
  });

  it("tags the texture sRGB (real, visible color, not a colorless data channel)", () => {
    const texture = createImageTexture(fakeImageBitmap(4, 4));
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("marks the texture ready for GPU upload", () => {
    // `needsUpdate` is write-only in Three.js (setting it bumps `.version`
    // internally; reading it back always yields `undefined`, verified
    // directly against the real three package), so `.version` having
    // advanced past its freshly-constructed `0` is the only observable
    // proof `needsUpdate = true` was actually set.
    const texture = createImageTexture(fakeImageBitmap(4, 4));
    expect(texture.version).toBeGreaterThan(0);
  });
});

describe("createDataTexture", () => {
  it("wraps the given pixel buffer as a DataTexture at the given size", () => {
    const pixels = new Uint8Array(8 * 4 * 4);
    const texture = createDataTexture(pixels, 8, 4);
    expect(texture).toBeInstanceOf(THREE.DataTexture);
    const image = (texture as THREE.DataTexture).image;
    expect(image.data).toBe(pixels);
    expect(image.width).toBe(8);
    expect(image.height).toBe(4);
  });

  it("flips Y (top-down source row order, e.g. pngjs's own decoded output, needs this to render right-side up)", () => {
    const texture = createDataTexture(new Uint8Array(4), 1, 1);
    expect(texture.flipY).toBe(true);
  });

  it("tags the texture sRGB (real, visible color, not a colorless data channel)", () => {
    const texture = createDataTexture(new Uint8Array(4), 1, 1);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it("marks the texture ready for GPU upload", () => {
    // See createImageTexture's own identical test for why .version, not
    // needsUpdate itself, is the only observable proof here.
    const texture = createDataTexture(new Uint8Array(4), 1, 1);
    expect(texture.version).toBeGreaterThan(0);
  });
});
