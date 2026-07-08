import { describe, expect, it } from "vitest";

import { cross, dot, length, normalizeOrZero, subtract } from "./vector-math.js";

describe("dot", () => {
  it("computes the dot product", () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it("is zero for perpendicular vectors", () => {
    expect(dot([1, 0, 0], [0, 1, 0])).toBe(0);
  });
});

describe("cross", () => {
  it("computes the cross product of the standard basis vectors", () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it("is anti-commutative", () => {
    const a: [number, number, number] = [1, 2, 3];
    const b: [number, number, number] = [4, 5, 6];
    const ab = cross(a, b);
    const ba = cross(b, a);
    expect(ab).toEqual([-ba[0], -ba[1], -ba[2]]);
  });
});

describe("subtract", () => {
  it("subtracts component-wise", () => {
    expect(subtract([5, 5, 5], [1, 2, 3])).toEqual([4, 3, 2]);
  });
});

describe("length", () => {
  it("computes the Euclidean length", () => {
    expect(length([3, 4, 0])).toBe(5);
  });

  it("is zero for the zero vector", () => {
    expect(length([0, 0, 0])).toBe(0);
  });
});

describe("normalizeOrZero", () => {
  it("normalizes a non-zero vector to unit length", () => {
    const normalized = normalizeOrZero([3, 4, 0]);
    expect(length(normalized)).toBeCloseTo(1, 10);
    expect(normalized).toEqual([0.6, 0.8, 0]);
  });

  it("returns the zero vector unchanged instead of dividing by zero", () => {
    expect(normalizeOrZero([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
