import { describe, expect, it } from "vitest";

import { sampleEmitterShape } from "./emitter-shape.js";

describe("sampleEmitterShape", () => {
  it("point shape always spawns at the local origin", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(sampleEmitterShape({ type: "point" }, 1, 0, i, 5, 0)).toEqual([0, 0, 0]);
    }
  });

  it("box shape stays within its own half-extents", () => {
    const halfExtents: [number, number, number] = [2, 1, 3];
    for (let i = 0; i < 200; i += 1) {
      const [x, y, z] = sampleEmitterShape({ type: "box", halfExtents }, 1, 0, i, 5, 0);
      expect(Math.abs(x)).toBeLessThanOrEqual(halfExtents[0]);
      expect(Math.abs(y)).toBeLessThanOrEqual(halfExtents[1]);
      expect(Math.abs(z)).toBeLessThanOrEqual(halfExtents[2]);
    }
  });

  it("sphere shape stays within its own radius", () => {
    const radius = 1.5;
    for (let i = 0; i < 200; i += 1) {
      const [x, y, z] = sampleEmitterShape({ type: "sphere", radius }, 1, 0, i, 5, 0);
      const distance = Math.sqrt(x * x + y * y + z * z);
      expect(distance).toBeLessThanOrEqual(radius + 1e-9);
    }
  });

  it("cone shape stays within a bounding radius and non-negative local y", () => {
    const radius = 1;
    const angle = Math.PI / 6;
    for (let i = 0; i < 200; i += 1) {
      const [x, y, z] = sampleEmitterShape({ type: "cone", radius, angle }, 1, 0, i, 5, 0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(radius + 1e-9);
    }
  });

  it("is deterministic for the same inputs", () => {
    const reference = sampleEmitterShape({ type: "sphere", radius: 1 }, 3, 2, 7, 10, 0);
    for (let trial = 0; trial < 100; trial += 1) {
      expect(sampleEmitterShape({ type: "sphere", radius: 1 }, 3, 2, 7, 10, 0)).toEqual(reference);
    }
  });

  it("produces different samples for different particle indices", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      samples.add(JSON.stringify(sampleEmitterShape({ type: "box", halfExtents: [1, 1, 1] }, 1, 0, i, 5, 0)));
    }
    expect(samples.size).toBe(50);
  });

  it("produces different samples for different dimension offsets, same particle", () => {
    const a = sampleEmitterShape({ type: "box", halfExtents: [1, 1, 1] }, 1, 0, 5, 5, 0);
    const b = sampleEmitterShape({ type: "box", halfExtents: [1, 1, 1] }, 1, 0, 5, 5, 20);
    expect(a).not.toEqual(b);
  });
});
