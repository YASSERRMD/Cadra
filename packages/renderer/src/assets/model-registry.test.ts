import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  createDefaultModelRegistry,
  createInMemoryModelRegistry,
  type LoadedModel,
} from "./model-registry.js";

function fakeLoadedModel(name: string): LoadedModel {
  return { scene: new THREE.Group(), animations: [new THREE.AnimationClip(name, 1, [])] };
}

describe("createInMemoryModelRegistry", () => {
  it("resolves undefined for an assetRef that was never registered", () => {
    const registry = createInMemoryModelRegistry();
    expect(registry.resolve("does-not-exist.glb")).toBeUndefined();
  });

  it("resolves the exact entry registered under a given assetRef", () => {
    const registry = createInMemoryModelRegistry();
    const entry = fakeLoadedModel("Walk");

    registry.register("character.glb", entry);

    expect(registry.resolve("character.glb")).toBe(entry);
  });

  it("keeps two different assetRefs independent", () => {
    const registry = createInMemoryModelRegistry();
    const hero = fakeLoadedModel("Walk");
    const villain = fakeLoadedModel("Idle");

    registry.register("hero.glb", hero);
    registry.register("villain.glb", villain);

    expect(registry.resolve("hero.glb")).toBe(hero);
    expect(registry.resolve("villain.glb")).toBe(villain);
  });

  it("overwrites a prior registration under the same assetRef", () => {
    const registry = createInMemoryModelRegistry();
    const first = fakeLoadedModel("Walk");
    const second = fakeLoadedModel("Run");

    registry.register("character.glb", first);
    registry.register("character.glb", second);

    expect(registry.resolve("character.glb")).toBe(second);
  });
});

describe("createDefaultModelRegistry", () => {
  it("starts empty", () => {
    expect(createDefaultModelRegistry().resolve("character.glb")).toBeUndefined();
  });

  it("gives each call its own independent registry, not a shared singleton", () => {
    const a = createDefaultModelRegistry();
    const b = createDefaultModelRegistry();

    a.register("character.glb", fakeLoadedModel("Walk"));

    expect(a.resolve("character.glb")).toBeDefined();
    expect(b.resolve("character.glb")).toBeUndefined();
  });
});
