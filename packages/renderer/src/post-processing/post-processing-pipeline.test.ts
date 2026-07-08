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

  it("is not a no-op with an empty effects array when sampleCount calls for accumulation", () => {
    const resolved = resolvePostProcessing({ effects: [], sampleCount: 8 });
    expect(resolved).not.toBeUndefined();
    expect(resolved?.sampleCount).toBe(8);
  });

  it("omits sampleCount from the resolved config when omitted or 1", () => {
    expect(resolvePostProcessing({ effects: [{ type: "sharpen", amount: 0.5 }] })?.sampleCount).toBeUndefined();
    expect(
      resolvePostProcessing({ effects: [{ type: "sharpen", amount: 0.5 }], sampleCount: 1 })?.sampleCount,
    ).toBeUndefined();
  });

  it("uses the full authored sampleCount at the 'final' tier", () => {
    const resolved = resolvePostProcessing({ tier: "final", effects: [], sampleCount: 32 });
    expect(resolved?.sampleCount).toBe(32);
  });

  it("caps sampleCount at the 'preview' tier", () => {
    const resolved = resolvePostProcessing({ tier: "preview", effects: [], sampleCount: 32 });
    expect(resolved?.sampleCount).toBe(4);
  });
});
