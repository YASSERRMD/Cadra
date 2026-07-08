import { describe, expect, it } from "vitest";

import { createIdentityTransform, type Transform } from "../scene-graph/primitives.js";
import type { ParticleColliderConfig, ParticleForceConfig } from "../scene-graph/scene-node.js";
import { Particles } from "./particles.js";

describe("Particles", () => {
  it("applies every default when only id is given", () => {
    const node = Particles({ id: "particles-1" });

    expect(node).toEqual({
      id: "particles-1",
      kind: "particles",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      maxParticles: 1000,
      emissionRate: 100,
      shape: { type: "point" },
      lifetimeSeconds: 2,
      initialSpeed: 1,
      direction: [0, 1, 0],
      startSize: 0.1,
    });
  });

  it("does not set a name key when name is omitted", () => {
    const node = Particles({ id: "particles-1" });

    expect("name" in node).toBe(false);
  });

  it("does not set any optional emitter key when omitted", () => {
    const node = Particles({ id: "particles-1" });

    for (const key of [
      "lifetimeVarianceSeconds",
      "initialSpeedVariance",
      "spreadAngle",
      "sizeVariance",
      "forces",
      "colliders",
      "colorOverLife",
      "sizeOverLife",
      "textureRef",
      "blendMode",
      "seed",
    ]) {
      expect(key in node).toBe(false);
    }
  });

  it("overrides every default when props are given", () => {
    const transform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [2, 2, 2] };
    const forces: ParticleForceConfig[] = [
      { type: "gravity", acceleration: [0, -9.81, 0] },
      { type: "curlNoise", strength: 2, frequency: 0.5 },
    ];
    const colliders: ParticleColliderConfig[] = [{ type: "groundPlane", y: 0, bounce: 0.4 }];

    const node = Particles({
      id: "particles-1",
      name: "Sparks",
      transform,
      visible: false,
      children: [],
      maxParticles: 5000,
      emissionRate: 250,
      shape: { type: "sphere", radius: 0.5 },
      lifetimeSeconds: 3,
      lifetimeVarianceSeconds: 0.5,
      initialSpeed: 4,
      initialSpeedVariance: 0.2,
      direction: [0, 1, 0],
      spreadAngle: 0.3,
      startSize: 0.05,
      sizeVariance: 0.1,
      forces,
      colliders,
      colorOverLife: [
        { time: 0, color: [1, 0.8, 0.2, 1] },
        { time: 1, color: [1, 0, 0, 0] },
      ],
      sizeOverLife: [
        { time: 0, size: 0 },
        { time: 1, size: 1 },
      ],
      textureRef: "spark-sprite",
      blendMode: "additive",
      seed: 7,
    });

    expect(node).toEqual({
      id: "particles-1",
      kind: "particles",
      name: "Sparks",
      transform,
      visible: false,
      children: [],
      maxParticles: 5000,
      emissionRate: 250,
      shape: { type: "sphere", radius: 0.5 },
      lifetimeSeconds: 3,
      lifetimeVarianceSeconds: 0.5,
      initialSpeed: 4,
      initialSpeedVariance: 0.2,
      direction: [0, 1, 0],
      spreadAngle: 0.3,
      startSize: 0.05,
      sizeVariance: 0.1,
      forces,
      colliders,
      colorOverLife: [
        { time: 0, color: [1, 0.8, 0.2, 1] },
        { time: 1, color: [1, 0, 0, 0] },
      ],
      sizeOverLife: [
        { time: 0, size: 0 },
        { time: 1, size: 1 },
      ],
      textureRef: "spark-sprite",
      blendMode: "additive",
      seed: 7,
    });
  });

  it("passing visible explicitly overrides the true default", () => {
    expect(Particles({ id: "p", visible: false }).visible).toBe(false);
    expect(Particles({ id: "p", visible: true }).visible).toBe(true);
  });
});
