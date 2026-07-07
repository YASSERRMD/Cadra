import { describe, expect, it } from "vitest";

import { isRtlLevel, resolveBidi } from "./bidi-resolution.js";

describe("resolveBidi", () => {
  it("resolves pure Latin text to all even (left-to-right) levels", () => {
    const resolution = resolveBidi("Hello");
    expect(Array.from(resolution.levels)).toEqual([0, 0, 0, 0, 0]);
  });

  it("resolves pure Arabic text to all odd (right-to-left) levels", () => {
    const resolution = resolveBidi("مرحبا");
    expect(Array.from(resolution.levels)).toEqual([1, 1, 1, 1, 1]);
  });

  it("resolves mixed Latin and Arabic text with per-run levels, absorbing whitespace into the surrounding base level", () => {
    const resolution = resolveBidi("AB مرحبا CD");
    expect(Array.from(resolution.levels)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0]);
  });

  it("is deterministic across repeated calls", () => {
    const first = resolveBidi("AB مرحبا CD");
    const second = resolveBidi("AB مرحبا CD");
    expect(Array.from(second.levels)).toEqual(Array.from(first.levels));
  });

  it("maps right-to-left parenthesis characters to their mirrored counterpart", () => {
    const resolution = resolveBidi("(abc)", "rtl");
    expect(resolution.mirroredCharacters.get(0)).toBe(")");
    expect(resolution.mirroredCharacters.get(4)).toBe("(");
  });
});

describe("isRtlLevel", () => {
  it("treats odd levels as right-to-left", () => {
    expect(isRtlLevel(1)).toBe(true);
    expect(isRtlLevel(3)).toBe(true);
  });

  it("treats even levels as left-to-right", () => {
    expect(isRtlLevel(0)).toBe(false);
    expect(isRtlLevel(2)).toBe(false);
  });
});
