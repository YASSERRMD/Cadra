import { describe, expect, it, vi } from "vitest";

import type { LoadFontDependencies, ParseFont } from "./font-loader.js";
import { loadFont } from "./font-loader.js";

function createFakeFontFace(label: string): FontFace {
  return { label } as unknown as FontFace;
}

describe("loadFont", () => {
  it("fetches bytes, then parses them into a font resource", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const font = createFakeFontFace("parsed-font");
    const callOrder: string[] = [];
    const deps: LoadFontDependencies = {
      fetchBytes: vi.fn(async () => {
        callOrder.push("fetchBytes");
        return bytes;
      }),
      parseFont: vi.fn(async () => {
        callOrder.push("parseFont");
        return font;
      }) as unknown as ParseFont,
    };

    const result = await loadFont("https://example.test/font.woff2", deps);

    expect(callOrder).toEqual(["fetchBytes", "parseFont"]);
    expect(result.font).toBe(font);
    expect(typeof result.hash).toBe("string");
  });

  it("produces the same hash for byte-identical font content", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const depsA: LoadFontDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      parseFont: vi.fn().mockResolvedValue(createFakeFontFace("a")) as unknown as ParseFont,
    };
    const depsB: LoadFontDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(bytes),
      parseFont: vi.fn().mockResolvedValue(createFakeFontFace("b")) as unknown as ParseFont,
    };

    const resultA = await loadFont("https://example.test/a.woff2", depsA);
    const resultB = await loadFont("https://example.test/b.woff2", depsB);

    expect(resultA.hash).toBe(resultB.hash);
  });

  it("propagates a parseFont rejection", async () => {
    const failure = new Error("invalid font format");
    const deps: LoadFontDependencies = {
      fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      parseFont: vi.fn().mockRejectedValue(failure) as unknown as ParseFont,
    };

    await expect(loadFont("https://example.test/font.woff2", deps)).rejects.toThrow(failure);
  });
});
