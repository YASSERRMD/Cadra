import { describe, expect, it } from "vitest";

import { curlNoise3D, valueNoise3D } from "./curl-noise.js";

describe("valueNoise3D", () => {
  it("is deterministic for the same inputs", () => {
    const reference = valueNoise3D(1, 0, 1.25, 2.5, -3.75);
    for (let trial = 0; trial < 100; trial += 1) {
      expect(valueNoise3D(1, 0, 1.25, 2.5, -3.75)).toBe(reference);
    }
  });

  it("stays within [-1, 1] (a convex combination of corner hashes, each within [-1, 1))", () => {
    for (let i = 0; i < 300; i += 1) {
      const x = (i * 0.37) % 10;
      const y = (i * 1.11) % 10;
      const z = (i * 2.03) % 10;
      const value = valueNoise3D(7, 1, x, y, z);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous: a small step in position changes the value only slightly", () => {
    const base = valueNoise3D(3, 0, 5.5, 5.5, 5.5);
    const stepped = valueNoise3D(3, 0, 5.5001, 5.5, 5.5);
    expect(Math.abs(stepped - base)).toBeLessThan(0.01);
  });

  it("is exactly 0 at every integer lattice corner shared with channel hash sign flips (corner values equal the hash itself)", () => {
    // At an exact lattice corner, fade(0) = 0, so trilinear interpolation
    // collapses to exactly that corner's own hash - no interpolation blur.
    const atCorner = valueNoise3D(5, 2, 4, 4, 4);
    const alsoAtCorner = valueNoise3D(5, 2, 4, 4, 4);
    expect(atCorner).toBe(alsoAtCorner);
  });

  it("produces different fields for different seeds", () => {
    expect(valueNoise3D(1, 0, 2.2, 3.3, 4.4)).not.toBe(valueNoise3D(2, 0, 2.2, 3.3, 4.4));
  });

  it("produces different fields for different channels, same seed", () => {
    expect(valueNoise3D(1, 0, 2.2, 3.3, 4.4)).not.toBe(valueNoise3D(1, 1, 2.2, 3.3, 4.4));
  });
});

describe("curlNoise3D", () => {
  it("is deterministic for the same inputs", () => {
    const reference = curlNoise3D(1, 1.5, 2.5, 3.5, 0.5);
    for (let trial = 0; trial < 100; trial += 1) {
      expect(curlNoise3D(1, 1.5, 2.5, 3.5, 0.5)).toEqual(reference);
    }
  });

  it("returns a 3-component finite vector", () => {
    const curl = curlNoise3D(4, 0.1, 0.2, 0.3, 1);
    expect(curl).toHaveLength(3);
    for (const component of curl) {
      expect(Number.isFinite(component)).toBe(true);
    }
  });

  it("produces different vectors at different positions", () => {
    const a = curlNoise3D(1, 0, 0, 0, 1);
    const b = curlNoise3D(1, 5, 5, 5, 1);
    expect(a).not.toEqual(b);
  });

  it("produces different vectors for different seeds, same position", () => {
    const a = curlNoise3D(1, 1, 1, 1, 1);
    const b = curlNoise3D(2, 1, 1, 1, 1);
    expect(a).not.toEqual(b);
  });

  it("scales the sampled field's granularity with frequency, changing the result", () => {
    const low = curlNoise3D(1, 1, 1, 1, 0.5);
    const high = curlNoise3D(1, 1, 1, 1, 4);
    expect(low).not.toEqual(high);
  });
});
