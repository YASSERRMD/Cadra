import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFontWithFontkit } from "@cadra/text";
import { describe, expect, it } from "vitest";

import type { LayerElement } from "./layer-element.js";
import { renderLayerToSvg, type SatoriLayerFont } from "./render-layer-to-svg.js";

function loadFixtureFont(name: string): Uint8Array {
  const path = fileURLToPath(
    new URL(`../../text/test-fixtures/fonts/${name}.ttf`, import.meta.url),
  );
  return new Uint8Array(readFileSync(path));
}

const INTER_VARIABLE = parseFontWithFontkit(loadFixtureFont("Inter-Variable"));

const REGULAR_FONT: SatoriLayerFont = {
  family: "Inter",
  font: INTER_VARIABLE,
  weight: 400,
  style: "normal",
  variationCoordinates: { wght: 400 },
};
const BOLD_FONT: SatoriLayerFont = {
  family: "Inter",
  font: INTER_VARIABLE,
  weight: 700,
  style: "normal",
  variationCoordinates: { wght: 700 },
};

const CARD_LAYER: LayerElement = {
  type: "div",
  style: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: "#111827",
    backgroundImage: "linear-gradient(90deg, #ff5f6d, #6a11cb)",
    borderRadius: 24,
    border: "2px solid #ffffff",
    boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
    padding: 24,
    gap: 8,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  children: [
    {
      type: "span",
      style: { fontFamily: "Inter", fontWeight: 700, fontSize: 32, color: "white" },
      children: ["Cadra"],
    },
    {
      type: "span",
      style: { fontFamily: "Inter", fontWeight: 400, fontSize: 16, color: "#e5e7eb" },
      children: ["Multi-weight styled card"],
    },
  ],
};

describe("renderLayerToSvg", () => {
  it("renders a styled flexbox card with multi-weight text to a valid SVG document", async () => {
    const svg = await renderLayerToSvg(CARD_LAYER, {
      width: 400,
      height: 200,
      fonts: [REGULAR_FONT, BOLD_FONT],
    });

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="400"');
    expect(svg).toContain('height="200"');
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  it("is byte-identical across repeated renders of the same styled card", async () => {
    const options = { width: 400, height: 200, fonts: [REGULAR_FONT, BOLD_FONT] };
    const first = await renderLayerToSvg(CARD_LAYER, options);
    const second = await renderLayerToSvg(CARD_LAYER, options);
    expect(second).toBe(first);
  });

  it("renders a linear-gradient background as an actual SVG gradient definition", async () => {
    const svg = await renderLayerToSvg(CARD_LAYER, {
      width: 400,
      height: 200,
      fonts: [REGULAR_FONT, BOLD_FONT],
    });
    expect(svg).toContain("linearGradient");
    expect(svg).toContain("#ff5f6d");
    expect(svg).toContain("#6a11cb");
  });

  it("renders a border radius as a clip path rather than a plain rectangle", async () => {
    const svg = await renderLayerToSvg(CARD_LAYER, {
      width: 400,
      height: 200,
      fonts: [REGULAR_FONT, BOLD_FONT],
    });
    expect(svg).toContain("clipPath");
  });

  it("embeds an image element via a data URI", async () => {
    const pngDataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const layer: LayerElement = {
      type: "div",
      style: { display: "flex", width: "100%", height: "100%" },
      children: [{ type: "img", src: pngDataUri, width: 50, height: 50 }],
    };

    const svg = await renderLayerToSvg(layer, { width: 100, height: 100, fonts: [] });
    expect(svg).toContain("<image");
  });

  it("actually applies flexbox layout: a row layout places children side by side, not stacked", async () => {
    const rowLayer: LayerElement = {
      type: "div",
      style: { display: "flex", flexDirection: "row", width: "100%", height: "100%" },
      children: [
        { type: "div", style: { width: 50, height: 50, backgroundColor: "red" } },
        { type: "div", style: { width: 50, height: 50, backgroundColor: "blue" } },
      ],
    };
    const columnLayer: LayerElement = {
      ...rowLayer,
      style: { ...rowLayer.style, flexDirection: "column" },
    };

    const rowSvg = await renderLayerToSvg(rowLayer, { width: 200, height: 200, fonts: [] });
    const columnSvg = await renderLayerToSvg(columnLayer, { width: 200, height: 200, fonts: [] });

    // Different layouts of the same two boxes must produce different
    // geometry, proving flexbox direction genuinely affects the output
    // rather than being silently ignored.
    expect(rowSvg).not.toBe(columnSvg);
  });

  it("supports a height-only dimension, inferring width to preserve the layer's own aspect ratio", async () => {
    const svg = await renderLayerToSvg(
      { type: "div", style: { width: 400, height: 200, backgroundColor: "red" } },
      { height: 100, fonts: [] },
    );
    expect(svg).toContain('height="100"');
  });
});
