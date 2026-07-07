import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LayerElement } from "@cadra/satori-layer";
import { renderLayerToSvg } from "@cadra/satori-layer";
import { parseFontWithFontkit } from "@cadra/text";
import { describe, expect, it } from "vitest";

import { rasterizeSvg } from "./rasterize-svg.js";

function loadFixtureFont(name: string): Uint8Array {
  const path = fileURLToPath(new URL(`../../text/test-fixtures/fonts/${name}.ttf`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}

const INTER_VARIABLE = parseFontWithFontkit(loadFixtureFont("Inter-Variable"));

const CARD_LAYER: LayerElement = {
  type: "div",
  style: {
    display: "flex",
    width: "100%",
    height: "100%",
    backgroundColor: "#1e293b",
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  children: [
    {
      type: "span",
      style: { fontFamily: "Inter", fontWeight: 700, fontSize: 28, color: "white" },
      children: ["Cadra"],
    },
  ],
};

describe("rasterizeSvg against real @cadra/satori-layer output", () => {
  it("rasterizes a real Satori-rendered layer's SVG to non-empty, non-uniform RGBA pixels", async () => {
    const svg = await renderLayerToSvg(CARD_LAYER, {
      width: 300,
      height: 150,
      fonts: [{ family: "Inter", font: INTER_VARIABLE, weight: 700, variationCoordinates: { wght: 700 } }],
    });

    const result = rasterizeSvg(svg);
    expect(result.width).toBe(300);
    expect(result.height).toBe(150);

    // The card has a dark background and white text: both a "background"
    // colored pixel and an opaque "text" colored pixel should exist,
    // proving real content actually rasterized rather than an empty canvas.
    const distinctColors = new Set<string>();
    for (let i = 0; i < result.pixels.length; i += 4) {
      distinctColors.add(
        `${result.pixels[i]},${result.pixels[i + 1]},${result.pixels[i + 2]},${result.pixels[i + 3]}`,
      );
    }
    expect(distinctColors.size).toBeGreaterThan(2);
  });

  it("rasterizes the same real layer deterministically end to end (satori render plus resvg raster)", async () => {
    const options = {
      width: 300,
      height: 150,
      fonts: [{ family: "Inter", font: INTER_VARIABLE, weight: 700, variationCoordinates: { wght: 700 } }],
    };
    const firstSvg = await renderLayerToSvg(CARD_LAYER, options);
    const secondSvg = await renderLayerToSvg(CARD_LAYER, options);
    expect(firstSvg).toBe(secondSvg);

    const first = rasterizeSvg(firstSvg, { supersample: 2 });
    const second = rasterizeSvg(secondSvg, { supersample: 2 });
    expect(Buffer.from(first.pixels).equals(Buffer.from(second.pixels))).toBe(true);
  });
});
