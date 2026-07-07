import { describe, expect, it } from "vitest";

import { recolorSvgText, resolveIconDataUri } from "./icon-resolver.js";

const SAMPLE_SVG =
  '<svg\n  class="lucide lucide-arrow-right"\n  xmlns="http://www.w3.org/2000/svg"\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  fill="none"\n  stroke="currentColor"\n>\n  <path d="M5 12h14" />\n</svg>';

describe("recolorSvgText", () => {
  it("returns the SVG unchanged when color is undefined", () => {
    expect(recolorSvgText(SAMPLE_SVG, undefined)).toBe(SAMPLE_SVG);
  });

  it("injects a color attribute onto the root svg element", () => {
    const recolored = recolorSvgText(SAMPLE_SVG, "#ff0000");
    expect(recolored).toContain('<svg color="#ff0000"');
    // The rest of the original root attributes must still be present, untouched.
    expect(recolored).toContain('stroke="currentColor"');
    expect(recolored).toContain('viewBox="0 0 24 24"');
  });

  it("escapes an XML-attribute-breaking color value rather than injecting it raw", () => {
    const malicious = '" onload="alert(1)';
    const recolored = recolorSvgText(SAMPLE_SVG, malicious);
    expect(recolored).not.toContain('onload="alert(1)"');
    expect(recolored).toContain("&quot;");
    expect(recolored).toContain("color=\"&quot; onload=&quot;alert(1)\"");
  });

  it("recolors a minimal self-closing-boundary root (svg immediately followed by '>')", () => {
    const recolored = recolorSvgText("<svg>", "blue");
    expect(recolored).toBe('<svg color="blue">');
  });
});

describe("resolveIconDataUri", () => {
  it("resolves a real icon to a data: URI wrapping recolored SVG", () => {
    const dataUri = resolveIconDataUri("arrow-right", "#00ff00");
    expect(dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    const decoded = Buffer.from(
      (dataUri as string).slice("data:image/svg+xml;base64,".length),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain('color="#00ff00"');
  });

  it("returns undefined for an icon name with no bundled asset", () => {
    expect(resolveIconDataUri("not-a-real-icon", undefined)).toBeUndefined();
  });
});
