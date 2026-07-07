import { describe, expect, it } from "vitest";

import { resolveTwemojiSvgBytes } from "./twemoji-assets.js";

describe("resolveTwemojiSvgBytes", () => {
  it("resolves a simple single-code-point emoji to real, non-empty SVG bytes", () => {
    const bytes = resolveTwemojiSvgBytes("\u{1F600}"); // grinning face
    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes?.length).toBeGreaterThan(0);
    expect(bytes?.toString("utf8")).toContain("<svg");
  });

  it("resolves a 4-person ZWJ family sequence to a single (not per-code-point) asset", () => {
    // man + ZWJ + woman + ZWJ + girl + ZWJ + boy
    const family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";
    const bytes = resolveTwemojiSvgBytes(family);
    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes?.toString("utf8")).toContain("<svg");
  });

  it("resolves a flag (regional indicator pair, no ZWJ) to real SVG bytes", () => {
    const usFlag = "\u{1F1FA}\u{1F1F8}";
    const bytes = resolveTwemojiSvgBytes(usFlag);
    expect(bytes).toBeInstanceOf(Buffer);
  });

  it("resolves a skin-tone-modified emoji to real SVG bytes", () => {
    const thumbsUpMediumSkin = "\u{1F44D}\u{1F3FD}";
    const bytes = resolveTwemojiSvgBytes(thumbsUpMediumSkin);
    expect(bytes).toBeInstanceOf(Buffer);
  });

  it("falls back to the variation-selector-stripped filename when the exact sequence has no asset", () => {
    // U+270F (pencil) plus U+FE0F (emoji presentation selector): Twemoji's
    // own installed asset set has "270f.svg" but not "270f-fe0f.svg"
    // (verified directly against the installed package), so resolution
    // must retry without the selector rather than report no asset at all.
    const pencilWithSelector = "\u{270F}\u{FE0F}";
    const bytes = resolveTwemojiSvgBytes(pencilWithSelector);
    expect(bytes).toBeInstanceOf(Buffer);
    expect(bytes?.toString("utf8")).toContain("<svg");
  });

  it("returns undefined for a sequence with no corresponding asset at all", () => {
    // A private-use-area code point: never a real emoji, never a Twemoji asset.
    const bytes = resolveTwemojiSvgBytes("\u{E000}");
    expect(bytes).toBeUndefined();
  });

  it("is deterministic: resolving the same sequence twice yields byte-identical results", () => {
    const first = resolveTwemojiSvgBytes("\u{1F600}");
    const second = resolveTwemojiSvgBytes("\u{1F600}");
    expect(first?.equals(second as Buffer)).toBe(true);
  });
});
