import { describe, expect, it } from "vitest";

import { resolveLucideIconSvgText } from "./icon-assets.js";

describe("resolveLucideIconSvgText", () => {
  it("resolves a real Lucide icon name to real, non-empty SVG source", () => {
    const svg = resolveLucideIconSvgText("arrow-right");
    expect(svg).toContain("<svg");
    expect(svg).toContain("lucide-arrow-right");
  });

  it("returns undefined for a name that is not a real Lucide icon", () => {
    expect(resolveLucideIconSvgText("this-icon-does-not-exist")).toBeUndefined();
  });

  it.each([
    "../../../etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "arrow-right/../../../etc/passwd",
    "/etc/passwd",
    "arrow_right",
    "Arrow-Right",
    "",
  ])("rejects a non-icon-shaped name %j without touching the filesystem", (maliciousOrInvalidName) => {
    expect(resolveLucideIconSvgText(maliciousOrInvalidName)).toBeUndefined();
  });

  it("is deterministic across repeated calls", () => {
    const first = resolveLucideIconSvgText("arrow-right");
    const second = resolveLucideIconSvgText("arrow-right");
    expect(second).toBe(first);
  });
});
