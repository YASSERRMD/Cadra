import { describe, expect, it } from "vitest";

import { particleHash, particleHashSigned } from "./hash.js";

describe("particleHash", () => {
  it("produces the exact same value for the same inputs, across 1000 fresh calls", () => {
    const reference = particleHash(42, 7, 100, 30, 0);

    for (let trial = 0; trial < 1000; trial += 1) {
      expect(particleHash(42, 7, 100, 30, 0)).toBe(reference);
    }
  });

  it("produces values within the half-open range [0, 1)", () => {
    for (let index = 0; index < 500; index += 1) {
      const value = particleHash(1, 0, index, 0, 0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("produces different values for different particle indices, same everything else", () => {
    const values = new Set<number>();
    for (let index = 0; index < 200; index += 1) {
      values.add(particleHash(1, 0, index, 10, 0));
    }
    expect(values.size).toBe(200);
  });

  it("produces different values for different frames, same everything else", () => {
    expect(particleHash(1, 0, 5, 1, 0)).not.toBe(particleHash(1, 0, 5, 2, 0));
  });

  it("produces different values for different dimensions, same everything else", () => {
    expect(particleHash(1, 0, 5, 1, 0)).not.toBe(particleHash(1, 0, 5, 1, 1));
  });

  it("produces different values for different emitter seeds, same everything else", () => {
    expect(particleHash(1, 0, 5, 1, 0)).not.toBe(particleHash(1, 1, 5, 1, 0));
  });

  it("produces different values for different composition seeds, same everything else", () => {
    expect(particleHash(1, 0, 5, 1, 0)).not.toBe(particleHash(2, 0, 5, 1, 0));
  });

  it("is unaffected by other hashes computed before or after it (no shared state)", () => {
    const reference = particleHash(9, 3, 40, 12, 2);

    for (let index = 0; index < 999; index += 1) {
      particleHash(index, index, index, index, index);
    }

    expect(particleHash(9, 3, 40, 12, 2)).toBe(reference);
  });
});

describe("particleHashSigned", () => {
  it("produces values within the half-open range [-1, 1)", () => {
    for (let index = 0; index < 500; index += 1) {
      const value = particleHashSigned(1, 0, index, 0, 0);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThan(1);
    }
  });

  it("is deterministic for the same inputs", () => {
    expect(particleHashSigned(5, 2, 8, 3, 1)).toBe(particleHashSigned(5, 2, 8, 3, 1));
  });

  it("is exactly particleHash rescaled from [0, 1) to [-1, 1)", () => {
    const base = particleHash(5, 2, 8, 3, 1);
    expect(particleHashSigned(5, 2, 8, 3, 1)).toBeCloseTo(base * 2 - 1, 12);
  });
});
