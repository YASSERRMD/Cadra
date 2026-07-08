import { describe, expect, it } from "vitest";

import { createIdentityTransform, type Transform } from "../scene-graph/primitives.js";
import { Volume } from "./volume.js";

describe("Volume", () => {
  it("applies every default when only id is given", () => {
    const node = Volume({ id: "volume-1" });

    expect(node).toEqual({
      id: "volume-1",
      kind: "volume",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      shape: { type: "sphere", radius: 1 },
      color: [0.8, 0.8, 0.85, 1],
      density: 1,
    });
  });

  it("does not set a name key when name is omitted", () => {
    const node = Volume({ id: "volume-1" });

    expect("name" in node).toBe(false);
  });

  it("does not set any optional field when omitted", () => {
    const node = Volume({ id: "volume-1" });

    for (const key of ["noiseFrequency", "driftSpeed", "raymarchSteps", "seed"]) {
      expect(key in node).toBe(false);
    }
  });

  it("overrides every default when props are given", () => {
    const transform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] };

    const node = Volume({
      id: "volume-1",
      name: "Mist",
      transform,
      visible: false,
      children: [],
      shape: { type: "box", halfExtents: [2, 1, 2] },
      color: [1, 1, 1, 0.5],
      density: 0.4,
      noiseFrequency: 2,
      driftSpeed: 0.3,
      raymarchSteps: 40,
      seed: 9,
    });

    expect(node).toEqual({
      id: "volume-1",
      kind: "volume",
      name: "Mist",
      transform,
      visible: false,
      children: [],
      shape: { type: "box", halfExtents: [2, 1, 2] },
      color: [1, 1, 1, 0.5],
      density: 0.4,
      noiseFrequency: 2,
      driftSpeed: 0.3,
      raymarchSteps: 40,
      seed: 9,
    });
  });

  it("passing visible explicitly overrides the true default", () => {
    expect(Volume({ id: "v", visible: false }).visible).toBe(false);
    expect(Volume({ id: "v", visible: true }).visible).toBe(true);
  });
});
