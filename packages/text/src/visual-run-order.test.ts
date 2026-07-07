import { describe, expect, it } from "vitest";

import { reorderRunsToVisualOrder } from "./visual-run-order.js";

function labeled(label: string, level: number): { label: string; level: number } {
  return { label, level };
}

describe("reorderRunsToVisualOrder", () => {
  it("returns an empty array unchanged", () => {
    expect(reorderRunsToVisualOrder([])).toEqual([]);
  });

  it("leaves purely left-to-right runs in logical order", () => {
    const runs = [labeled("a", 0), labeled("b", 0), labeled("c", 0)];
    expect(reorderRunsToVisualOrder(runs).map((r) => r.label)).toEqual(["a", "b", "c"]);
  });

  it("leaves a single embedded right-to-left run's position unchanged", () => {
    const runs = [labeled("a", 0), labeled("b", 1), labeled("c", 0)];
    expect(reorderRunsToVisualOrder(runs).map((r) => r.label)).toEqual(["a", "b", "c"]);
  });

  it("reverses two adjacent same-level right-to-left runs (their logical reading order is right to left)", () => {
    const runs = [labeled("a", 0), labeled("word1", 1), labeled("word2", 1), labeled("d", 0)];
    expect(reorderRunsToVisualOrder(runs).map((r) => r.label)).toEqual(["a", "word2", "word1", "d"]);
  });

  it("resolves nested embeddings per UAX #9 rule L2 (reverse from the highest level down to the lowest odd level)", () => {
    const runs = [labeled("a", 0), labeled("b", 1), labeled("c", 2), labeled("d", 1), labeled("e", 0)];
    expect(reorderRunsToVisualOrder(runs).map((r) => r.label)).toEqual(["a", "d", "c", "b", "e"]);
  });

  it("does not mutate the input array", () => {
    const runs = [labeled("a", 0), labeled("b", 1), labeled("c", 0)];
    const original = runs.slice();
    reorderRunsToVisualOrder(runs);
    expect(runs).toEqual(original);
  });

  it("is deterministic across repeated calls", () => {
    const runs = [labeled("a", 0), labeled("b", 1), labeled("c", 2), labeled("d", 1), labeled("e", 0)];
    expect(reorderRunsToVisualOrder(runs)).toEqual(reorderRunsToVisualOrder(runs));
  });
});
