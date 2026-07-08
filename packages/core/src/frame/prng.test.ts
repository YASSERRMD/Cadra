import { describe, expect, it } from "vitest";

import { createFrameRandom, toNumericSeed } from "./prng.js";

/** How many values to draw from a single generator in each trial below. */
const VALUES_PER_TRIAL = 50;

/**
 * Number of fresh-context trials run for the core determinism proof. At
 * `VALUES_PER_TRIAL` draws each, this exceeds 1000 total assertions of
 * "same seed and frame produce the same value", covering the acceptance
 * criterion of at least 1000 repeats.
 */
const TRIAL_COUNT = 1000;

function drawSequence(seed: string | number, frame: number, count: number): number[] {
  const random = createFrameRandom(seed, frame);
  return Array.from({ length: count }, () => random.next());
}

describe("createFrameRandom", () => {
  it("produces the exact same sequence for the same (seed, frame) pair, across 1000 fresh constructions", () => {
    const reference = drawSequence("phase-03", 500, VALUES_PER_TRIAL);

    for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
      const sequence = drawSequence("phase-03", 500, VALUES_PER_TRIAL);
      expect(sequence).toEqual(reference);
    }
  });

  it("produces the same sequence for the same numeric seed and frame", () => {
    const sequenceA = drawSequence(42, 7, VALUES_PER_TRIAL);
    const sequenceB = drawSequence(42, 7, VALUES_PER_TRIAL);

    expect(sequenceA).toEqual(sequenceB);
  });

  it("is unaffected by other generators created before or after it (no shared/accumulating state)", () => {
    const reference = drawSequence("order-check", 500, VALUES_PER_TRIAL);

    // Simulate "other frames evaluated in between": create and draw from
    // many unrelated generators, then re-derive the same (seed, frame) pair
    // and confirm it is unchanged.
    for (let frame = 0; frame < 999; frame += 1) {
      createFrameRandom("order-check", frame).next();
    }
    const afterOtherFrames = drawSequence("order-check", 500, VALUES_PER_TRIAL);

    expect(afterOtherFrames).toEqual(reference);
  });

  it("matches evaluating frames 0..999 in order and inspecting frame 500 in isolation", () => {
    const inOrderValues: number[] = [];
    for (let frame = 0; frame <= 999; frame += 1) {
      const random = createFrameRandom("in-order", frame);
      const firstValue = random.next();
      if (frame === 500) {
        inOrderValues.push(firstValue);
      }
    }

    const isolated = createFrameRandom("in-order", 500).next();

    expect(inOrderValues).toEqual([isolated]);
  });

  it("produces different sequences for different seeds at the same frame", () => {
    const sequenceA = drawSequence("seed-a", 10, VALUES_PER_TRIAL);
    const sequenceB = drawSequence("seed-b", 10, VALUES_PER_TRIAL);

    expect(sequenceA).not.toEqual(sequenceB);
  });

  it("produces different sequences for different frames at the same seed", () => {
    const sequenceA = drawSequence("shared-seed", 1, VALUES_PER_TRIAL);
    const sequenceB = drawSequence("shared-seed", 2, VALUES_PER_TRIAL);

    expect(sequenceA).not.toEqual(sequenceB);
  });

  it("produces values within the half-open range [0, 1)", () => {
    const random = createFrameRandom("range-check", 0);

    for (let i = 0; i < VALUES_PER_TRIAL; i += 1) {
      const value = random.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("advances state between calls on the same generator, rather than returning a constant", () => {
    const random = createFrameRandom("advance-check", 3);
    const first = random.next();
    const second = random.next();

    expect(first).not.toBe(second);
  });

  it("treats a numeric seed and its string form as different seeds", () => {
    const numericSequence = drawSequence(1234, 0, VALUES_PER_TRIAL);
    const stringSequence = drawSequence("1234", 0, VALUES_PER_TRIAL);

    expect(numericSequence).not.toEqual(stringSequence);
  });
});

describe("toNumericSeed", () => {
  it("passes an already-numeric seed through, truncated to a 32-bit unsigned integer", () => {
    expect(toNumericSeed(42)).toBe(42);
    expect(toNumericSeed(0)).toBe(0);
  });

  it("hashes a string seed to the same numeric value every time", () => {
    expect(toNumericSeed("phase-67")).toBe(toNumericSeed("phase-67"));
  });

  it("hashes different string seeds to different numeric values", () => {
    expect(toNumericSeed("emitter-a")).not.toBe(toNumericSeed("emitter-b"));
  });

  it("always returns a 32-bit unsigned integer", () => {
    for (const seed of [42, -1, "phase-67", "", "a very long emitter identifier string"]) {
      const numeric = toNumericSeed(seed);
      expect(Number.isInteger(numeric)).toBe(true);
      expect(numeric).toBeGreaterThanOrEqual(0);
      expect(numeric).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
