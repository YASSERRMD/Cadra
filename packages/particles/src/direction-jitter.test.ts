import { describe, expect, it } from "vitest";

import { jitterDirection } from "./direction-jitter.js";
import { dot, length } from "./vector-math.js";

describe("jitterDirection", () => {
  it("returns the exact normalized base direction when spreadAngle is 0", () => {
    const result = jitterDirection([0, 2, 0], 0, 1, 0, 5, 10, 0);
    expect(result).toEqual([0, 1, 0]);
  });

  it("returns the zero vector when baseDirection is the zero vector", () => {
    const result = jitterDirection([0, 0, 0], 0.5, 1, 0, 5, 10, 0);
    expect(result).toEqual([0, 0, 0]);
  });

  it("always returns a unit vector when spreadAngle is positive", () => {
    for (let i = 0; i < 200; i += 1) {
      const result = jitterDirection([0, 1, 0], 0.5, 1, 0, i, 10, 0);
      expect(length(result)).toBeCloseTo(1, 6);
    }
  });

  it("stays within spreadAngle of the base direction", () => {
    const baseDirection: [number, number, number] = [0, 1, 0];
    const spreadAngle = Math.PI / 6;
    for (let i = 0; i < 200; i += 1) {
      const result = jitterDirection(baseDirection, spreadAngle, 1, 0, i, 10, 0);
      const cosAngle = dot(result, baseDirection);
      expect(cosAngle).toBeGreaterThanOrEqual(Math.cos(spreadAngle) - 1e-9);
    }
  });

  it("is deterministic for the same inputs", () => {
    const reference = jitterDirection([1, 0, 0], 0.3, 2, 1, 9, 4, 0);
    for (let trial = 0; trial < 50; trial += 1) {
      expect(jitterDirection([1, 0, 0], 0.3, 2, 1, 9, 4, 0)).toEqual(reference);
    }
  });

  it("produces different directions for different particle indices", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      samples.add(JSON.stringify(jitterDirection([0, 1, 0], 0.5, 1, 0, i, 10, 0)));
    }
    expect(samples.size).toBe(50);
  });

  it("handles a base direction nearly aligned with the fallback up vector", () => {
    const result = jitterDirection([0, 1, 0], 0.4, 1, 0, 3, 7, 0);
    expect(length(result)).toBeCloseTo(1, 6);
    expect(Number.isFinite(result[0])).toBe(true);
    expect(Number.isFinite(result[1])).toBe(true);
    expect(Number.isFinite(result[2])).toBe(true);
  });
});
