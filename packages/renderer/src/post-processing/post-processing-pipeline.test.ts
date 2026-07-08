import { describe, expect, it } from "vitest";

import { resolvePostProcessing } from "./post-processing-pipeline.js";

describe("resolvePostProcessing", () => {
  it("returns undefined when postProcessing is undefined", () => {
    expect(resolvePostProcessing(undefined)).toBeUndefined();
  });

  it("returns undefined when effects is an empty array (a no-op stack)", () => {
    expect(resolvePostProcessing({ effects: [] })).toBeUndefined();
  });

  it("resolves tier to 'final' by default", () => {
    const resolved = resolvePostProcessing({ effects: [{ type: "sharpen", amount: 0.5 }] });
    expect(resolved?.tier).toBe("final");
  });

  it("preserves an explicit 'preview' tier", () => {
    const resolved = resolvePostProcessing({
      tier: "preview",
      effects: [{ type: "sharpen", amount: 0.5 }],
    });
    expect(resolved?.tier).toBe("preview");
  });

  it("preserves the effects array, in order, unchanged", () => {
    const effects = [{ type: "sharpen" as const, amount: 0.3 }];
    const resolved = resolvePostProcessing({ effects });
    expect(resolved?.effects).toEqual(effects);
  });

  it("is deterministic: repeated calls with equal input produce equal output", () => {
    const postProcessing = { tier: "preview" as const, effects: [{ type: "sharpen" as const, amount: 0.8 }] };
    expect(resolvePostProcessing(postProcessing)).toEqual(resolvePostProcessing({ ...postProcessing }));
  });
});
