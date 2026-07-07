import { describe, expect, it } from "vitest";

import { resolveEmojiDataUri } from "./emoji-resolver.js";

describe("resolveEmojiDataUri", () => {
  it("resolves a real emoji to a data: URI wrapping valid, non-empty SVG", () => {
    const dataUri = resolveEmojiDataUri("\u{1F600}");
    expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    const base64 = (dataUri as string).slice("data:image/svg+xml;base64,".length);
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    expect(decoded).toContain("<svg");
  });

  it("returns undefined for a sequence with no corresponding Twemoji asset", () => {
    expect(resolveEmojiDataUri("\u{E000}")).toBeUndefined();
  });

  it("is deterministic across repeated calls", () => {
    const first = resolveEmojiDataUri("\u{1F44D}\u{1F3FD}");
    const second = resolveEmojiDataUri("\u{1F44D}\u{1F3FD}");
    expect(second).toBe(first);
  });
});
