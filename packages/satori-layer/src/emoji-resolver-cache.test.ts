import { describe, expect, it, vi } from "vitest";

import * as emojiResolverModule from "./emoji-resolver.js";
import { createEmojiResolverCache } from "./emoji-resolver-cache.js";

describe("createEmojiResolverCache", () => {
  it("resolves only once for repeated identical requests", () => {
    const resolveSpy = vi.spyOn(emojiResolverModule, "resolveEmojiDataUri");
    const cache = createEmojiResolverCache();

    const first = cache.resolve("\u{1F600}");
    const second = cache.resolve("\u{1F600}");

    expect(second).toBe(first);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    resolveSpy.mockRestore();
  });

  it("resolves again for a different grapheme", () => {
    const cache = createEmojiResolverCache();
    const a = cache.resolve("\u{1F600}");
    const b = cache.resolve("\u{1F601}");
    expect(a).not.toBe(b);
  });

  it("caches a negative result (no asset for this grapheme) too, without re-resolving", () => {
    const resolveSpy = vi.spyOn(emojiResolverModule, "resolveEmojiDataUri");
    const cache = createEmojiResolverCache();

    const first = cache.resolve("\u{E000}");
    const second = cache.resolve("\u{E000}");

    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    resolveSpy.mockRestore();
  });
});
