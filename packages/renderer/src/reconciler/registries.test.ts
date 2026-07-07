import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  createDefaultGeometryRegistry,
  createDefaultMaterialRegistry,
  createDefaultTextureRegistry,
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

  it("resolves box and sphere to their specific geometry classes", () => {
    const registry = createDefaultGeometryRegistry();
    expect(registry.resolve("box")).toBeInstanceOf(THREE.BoxGeometry);
    expect(registry.resolve("sphere")).toBeInstanceOf(THREE.SphereGeometry);
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
  it("resolves every ref to undefined (no texture asset pipeline seeded yet)", () => {
    const registry = createDefaultTextureRegistry();
    expect(registry.resolve("normal-1")).toBeUndefined();
    expect(registry.resolve("does-not-exist")).toBeUndefined();
  });
});
