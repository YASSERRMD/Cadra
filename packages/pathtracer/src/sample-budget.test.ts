import { describe, expect, it } from "vitest";

import { resolvePathTracingConfig, resolveSampleBudgetForTier } from "./sample-budget.js";

describe("resolveSampleBudgetForTier", () => {
  it("uses the authored value when present, regardless of tier", () => {
    expect(resolveSampleBudgetForTier("final", 64)).toBe(64);
    expect(resolveSampleBudgetForTier("preview", 64)).toBe(64);
  });

  it("defaults to a high sample count at the 'final' tier when omitted", () => {
    expect(resolveSampleBudgetForTier("final", undefined)).toBe(256);
  });

  it("defaults to a low sample count at the 'preview' tier when omitted", () => {
    expect(resolveSampleBudgetForTier("preview", undefined)).toBe(16);
  });

  it("is deterministic: repeated calls with the same input produce the same output", () => {
    expect(resolveSampleBudgetForTier("final", undefined)).toBe(resolveSampleBudgetForTier("final", undefined));
  });
});

describe("resolvePathTracingConfig", () => {
  it("resolves every default when config is undefined", () => {
    expect(resolvePathTracingConfig(undefined)).toEqual({
      tier: "final",
      samples: 256,
      bounces: 5,
    });
  });

  it("resolves every default when config is an empty object", () => {
    expect(resolvePathTracingConfig({})).toEqual({
      tier: "final",
      samples: 256,
      bounces: 5,
    });
  });

  it("preserves an authored tier and its own tier-dependent sample default", () => {
    expect(resolvePathTracingConfig({ tier: "preview" })).toEqual({
      tier: "preview",
      samples: 16,
      bounces: 5,
    });
  });

  it("preserves fully authored values unchanged", () => {
    expect(resolvePathTracingConfig({ tier: "preview", samples: 8, bounces: 3 })).toEqual({
      tier: "preview",
      samples: 8,
      bounces: 3,
    });
  });
});
