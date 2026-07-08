import { describe, expect, it } from "vitest";

import { resolveSampleCountForTier, resolveSampleLevel } from "./temporal-accumulation.js";

describe("resolveSampleCountForTier", () => {
  it("uses the full authored value at the 'final' tier", () => {
    expect(resolveSampleCountForTier(32, "final")).toBe(32);
  });

  it("caps the authored value at the 'preview' tier", () => {
    expect(resolveSampleCountForTier(32, "preview")).toBe(4);
  });

  it("does not raise a small authored value up to the preview cap", () => {
    expect(resolveSampleCountForTier(2, "preview")).toBe(2);
  });

  it("is deterministic: repeated calls with the same input produce the same output", () => {
    expect(resolveSampleCountForTier(16, "preview")).toBe(resolveSampleCountForTier(16, "preview"));
  });
});

describe("resolveSampleLevel", () => {
  it("resolves 1 sample to level 0", () => {
    expect(resolveSampleLevel(1)).toBe(0);
  });

  it("resolves exact powers of two to their own log2 level", () => {
    expect(resolveSampleLevel(2)).toBe(1);
    expect(resolveSampleLevel(4)).toBe(2);
    expect(resolveSampleLevel(8)).toBe(3);
    expect(resolveSampleLevel(16)).toBe(4);
    expect(resolveSampleLevel(32)).toBe(5);
  });

  it("rounds a non-power-of-two count up, never down (never under-samples)", () => {
    expect(resolveSampleLevel(3)).toBe(2);
    expect(resolveSampleLevel(5)).toBe(3);
    expect(resolveSampleLevel(17)).toBe(5);
  });

  it("clamps above 32 samples down to level 5", () => {
    expect(resolveSampleLevel(1000)).toBe(5);
  });

  it("clamps 0 or negative counts up to level 0", () => {
    expect(resolveSampleLevel(0)).toBe(0);
    expect(resolveSampleLevel(-5)).toBe(0);
  });
});
