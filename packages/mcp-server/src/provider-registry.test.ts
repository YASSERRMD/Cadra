import { describe, expect, it } from "vitest";

import { buildVideoProviderRegistry } from "./provider-registry.js";

describe("buildVideoProviderRegistry", () => {
  it("returns an empty registry when no provider keys are configured", () => {
    expect(buildVideoProviderRegistry({})).toEqual({});
  });

  it("registers veo, runway, luma, and pika independently from a single apiKey each", () => {
    const registry = buildVideoProviderRegistry({
      veo: "veo-key",
      runway: "runway-key",
      luma: "luma-key",
      pika: "pika-key",
    });

    expect(Object.keys(registry).sort()).toEqual(["luma", "pika", "runway", "veo"]);
    expect(registry.veo?.name).toBe("veo");
    expect(registry.runway?.name).toBe("runway");
    expect(registry.luma?.name).toBe("luma");
    expect(registry.pika?.name).toBe("pika");
  });

  it("registers kling only when both kling_access and kling_secret are present", () => {
    expect(buildVideoProviderRegistry({ kling_access: "ak" })).toEqual({});
    expect(buildVideoProviderRegistry({ kling_secret: "sk" })).toEqual({});

    const registry = buildVideoProviderRegistry({ kling_access: "ak", kling_secret: "sk" });
    expect(registry.kling?.name).toBe("kling");
  });

  it("leaves an unconfigured provider absent from the registry rather than registering it with an empty key", () => {
    const registry = buildVideoProviderRegistry({ veo: "veo-key" });
    expect(registry.runway).toBeUndefined();
    expect(registry.kling).toBeUndefined();
    expect(Object.keys(registry)).toEqual(["veo"]);
  });

  it("ignores unrelated provider keys (e.g. anthropic, the text-to-scene LLM key)", () => {
    const registry = buildVideoProviderRegistry({ anthropic: "anthropic-key" });
    expect(registry).toEqual({});
  });
});
