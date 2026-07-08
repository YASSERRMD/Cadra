import { describe, expect, it } from "vitest";

import { createIdentityTransform, type Transform } from "../scene-graph/primitives.js";
import { Model } from "./model.js";

describe("Model", () => {
  it("applies every default when only id and assetRef are given", () => {
    const node = Model({ id: "model-1", assetRef: "character.glb" });

    expect(node).toEqual({
      id: "model-1",
      kind: "model",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      assetRef: "character.glb",
    });
  });

  it("does not set a name key when name is omitted", () => {
    const node = Model({ id: "model-1", assetRef: "character.glb" });

    expect("name" in node).toBe(false);
  });

  it("does not set any optional field when omitted", () => {
    const node = Model({ id: "model-1", assetRef: "character.glb" });

    for (const key of ["castShadow", "receiveShadow", "clips", "morphTargets"]) {
      expect(key in node).toBe(false);
    }
  });

  it("overrides every default when props are given", () => {
    const transform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] };
    const clips = [{ name: "Walk", weight: 1, timeScale: 1.5, loop: "repeat" as const }];
    const morphTargets = { smile: 0.5 };

    const node = Model({
      id: "model-1",
      name: "Hero",
      transform,
      visible: false,
      children: [],
      assetRef: "character.glb",
      castShadow: true,
      receiveShadow: true,
      clips,
      morphTargets,
    });

    expect(node).toEqual({
      id: "model-1",
      kind: "model",
      name: "Hero",
      transform,
      visible: false,
      children: [],
      assetRef: "character.glb",
      castShadow: true,
      receiveShadow: true,
      clips,
      morphTargets,
    });
  });

  it("passing visible explicitly overrides the true default", () => {
    expect(Model({ id: "m", assetRef: "a.glb", visible: false }).visible).toBe(false);
    expect(Model({ id: "m", assetRef: "a.glb", visible: true }).visible).toBe(true);
  });
});
