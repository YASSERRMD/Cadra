import { describe, expect, it } from "vitest";

import { computeFilmGrainSeed } from "./film-grain.js";

describe("computeFilmGrainSeed", () => {
  it("is deterministic: the same frame always produces the exact same seed", () => {
    expect(computeFilmGrainSeed(42)).toBe(computeFilmGrainSeed(42));
  });

  it("is 0 at frame 0", () => {
    expect(computeFilmGrainSeed(0)).toBe(0);
  });

  it("differs between consecutive frames", () => {
    expect(computeFilmGrainSeed(1)).not.toBe(computeFilmGrainSeed(2));
  });

  it("never lands back on an exact integer for any frame in a large range (no visible short-period repeat)", () => {
    for (let frame = 1; frame <= 200; frame += 1) {
      expect(Number.isInteger(computeFilmGrainSeed(frame))).toBe(false);
    }
  });

  it("is a pure function of frame, not the wall clock: two calls made apart in real time still agree", async () => {
    const first = computeFilmGrainSeed(7);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = computeFilmGrainSeed(7);
    expect(second).toBe(first);
  });
});
