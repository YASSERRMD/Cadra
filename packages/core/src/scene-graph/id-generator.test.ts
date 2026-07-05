import { describe, expect, it } from "vitest";

import { createIdGenerator } from "./id-generator.js";

describe("createIdGenerator", () => {
  it("produces the same sequence of ids for the same string seed", () => {
    const genA = createIdGenerator("phase-02");
    const genB = createIdGenerator("phase-02");

    const sequenceA = Array.from({ length: 10 }, () => genA());
    const sequenceB = Array.from({ length: 10 }, () => genB());

    expect(sequenceA).toEqual(sequenceB);
  });

  it("produces the same sequence of ids for the same numeric seed", () => {
    const genA = createIdGenerator(42);
    const genB = createIdGenerator(42);

    expect(genA()).toBe(genB());
    expect(genA()).toBe(genB());
  });

  it("produces different sequences for different seeds", () => {
    const genA = createIdGenerator("seed-a");
    const genB = createIdGenerator("seed-b");

    const sequenceA = Array.from({ length: 5 }, () => genA());
    const sequenceB = Array.from({ length: 5 }, () => genB());

    expect(sequenceA).not.toEqual(sequenceB);
  });

  it("does not repeat an id within a single sequence in practice", () => {
    const gen = createIdGenerator("uniqueness-check");
    const ids = Array.from({ length: 200 }, () => gen());

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("advances state between calls, rather than returning a constant", () => {
    const gen = createIdGenerator("advance-check");
    const first = gen();
    const second = gen();

    expect(first).not.toBe(second);
  });

  it("returns non-empty string ids", () => {
    const gen = createIdGenerator("shape-check");
    const id = gen();

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });
});
