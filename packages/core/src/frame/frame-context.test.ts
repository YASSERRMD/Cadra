import { describe, expect, it } from "vitest";

import { createFrameContext } from "./frame-context.js";

const BASE_INPUT = {
  frame: 120,
  fps: 30,
  durationInFrames: 900,
  seed: "phase-03-context",
};

describe("createFrameContext", () => {
  it("computes time as frame / fps", () => {
    const context = createFrameContext(BASE_INPUT);

    expect(context.time).toBe(4);
  });

  it("produces identical plain-data fields for identical inputs, constructed twice", () => {
    const contextA = createFrameContext(BASE_INPUT);
    const contextB = createFrameContext(BASE_INPUT);

    expect(contextA.frame).toBe(contextB.frame);
    expect(contextA.fps).toBe(contextB.fps);
    expect(contextA.time).toBe(contextB.time);
    expect(contextA.durationInFrames).toBe(contextB.durationInFrames);
    expect(contextA.seed).toBe(contextB.seed);
  });

  it("produces plain-data fields that survive structuredClone with full equality", () => {
    const context = createFrameContext(BASE_INPUT);
    const { frame, fps, time, durationInFrames, seed } = context;

    const cloned = structuredClone({ frame, fps, time, durationInFrames, seed });

    expect(cloned).toEqual({ frame, fps, time, durationInFrames, seed });
  });

  it("produces plain-data fields that survive a JSON round trip with full equality", () => {
    const context = createFrameContext(BASE_INPUT);
    const { frame, fps, time, durationInFrames, seed } = context;
    const plain = { frame, fps, time, durationInFrames, seed };

    const roundTripped = JSON.parse(JSON.stringify(plain)) as typeof plain;

    expect(roundTripped).toEqual(plain);
  });

  it("carries a numeric seed through unchanged", () => {
    const context = createFrameContext({ ...BASE_INPUT, seed: 4242 });

    expect(context.seed).toBe(4242);
  });

  it("exposes a random() accessor deriving a generator from (seed, frame)", () => {
    const contextA = createFrameContext(BASE_INPUT);
    const contextB = createFrameContext(BASE_INPUT);

    const sequenceA = Array.from({ length: 20 }, () => contextA.random().next());
    const sequenceB = Array.from({ length: 20 }, () => contextB.random().next());

    // Each call to random() derives a fresh generator from (seed, frame), so
    // calling it repeatedly and reading one value each time still reproduces
    // the same sequence a single generator would produce.
    expect(sequenceA).toEqual(sequenceB);
  });

  it("returns a fresh generator producing the same first value every time random() is called", () => {
    const context = createFrameContext(BASE_INPUT);

    // random() derives a brand new generator from (seed, frame) on every
    // call rather than advancing a shared one, so calling it repeatedly and
    // reading only the first value each time yields the same value every
    // time, not an advancing sequence.
    const firstValues = Array.from({ length: 10 }, () => context.random().next());

    expect(new Set(firstValues).size).toBe(1);
  });

  it("a single generator from random() advances across sequential next() calls", () => {
    const context = createFrameContext(BASE_INPUT);

    const generator = context.random();
    const sequence = Array.from({ length: 10 }, () => generator.next());

    expect(new Set(sequence).size).toBe(sequence.length);
  });

  it("gives different contexts (different frame) different random sequences", () => {
    const contextA = createFrameContext({ ...BASE_INPUT, frame: 1 });
    const contextB = createFrameContext({ ...BASE_INPUT, frame: 2 });

    expect(contextA.random().next()).not.toBe(contextB.random().next());
  });

  it("gives different contexts (different seed) different random sequences", () => {
    const contextA = createFrameContext({ ...BASE_INPUT, seed: "seed-a" });
    const contextB = createFrameContext({ ...BASE_INPUT, seed: "seed-b" });

    expect(contextA.random().next()).not.toBe(contextB.random().next());
  });
});
