import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFontWithFontkit } from "@cadra/text";
import { describe, expect, it } from "vitest";

import type { LayerElement } from "./layer-element.js";
import { computeRenderLayerCacheKey } from "./render-layer-cache-key.js";
import type { SatoriLayerFont } from "./render-layer-to-svg.js";

function loadFixtureFont(name: string): Uint8Array {
  const path = fileURLToPath(
    new URL(`../../text/test-fixtures/fonts/${name}.ttf`, import.meta.url),
  );
  return new Uint8Array(readFileSync(path));
}

const INTER_VARIABLE = parseFontWithFontkit(loadFixtureFont("Inter-Variable"));
const FONT: SatoriLayerFont = { family: "Inter", font: INTER_VARIABLE, weight: 400 };

describe("computeRenderLayerCacheKey", () => {
  it("is stable for the same layer and options", () => {
    const layer: LayerElement = { type: "div", style: { color: "red" } };
    const a = computeRenderLayerCacheKey(layer, { width: 100, height: 100, fonts: [FONT] });
    const b = computeRenderLayerCacheKey(layer, { width: 100, height: 100, fonts: [FONT] });
    expect(a).toBe(b);
  });

  it("is independent of a style object's own authored key order", () => {
    const layerA: LayerElement = { type: "div", style: { color: "red", fontSize: 12 } };
    const layerB: LayerElement = { type: "div", style: { fontSize: 12, color: "red" } };
    const a = computeRenderLayerCacheKey(layerA, { width: 100, height: 100, fonts: [FONT] });
    const b = computeRenderLayerCacheKey(layerB, { width: 100, height: 100, fonts: [FONT] });
    expect(a).toBe(b);
  });

  it("differs when the layer tree differs", () => {
    const a = computeRenderLayerCacheKey(
      { type: "div", style: { color: "red" } },
      { width: 100, height: 100, fonts: [FONT] },
    );
    const b = computeRenderLayerCacheKey(
      { type: "div", style: { color: "blue" } },
      { width: 100, height: 100, fonts: [FONT] },
    );
    expect(a).not.toBe(b);
  });

  it("differs when dimensions differ", () => {
    const layer: LayerElement = { type: "div" };
    const a = computeRenderLayerCacheKey(layer, { width: 100, height: 100, fonts: [FONT] });
    const b = computeRenderLayerCacheKey(layer, { width: 200, height: 100, fonts: [FONT] });
    expect(a).not.toBe(b);
  });

  it("differs when a font's weight differs", () => {
    const layer: LayerElement = { type: "div" };
    const a = computeRenderLayerCacheKey(layer, { width: 100, height: 100, fonts: [{ ...FONT, weight: 400 }] });
    const b = computeRenderLayerCacheKey(layer, { width: 100, height: 100, fonts: [{ ...FONT, weight: 700 }] });
    expect(a).not.toBe(b);
  });

  it("differs when a font's variation coordinates differ", () => {
    const layer: LayerElement = { type: "div" };
    const a = computeRenderLayerCacheKey(layer, {
      width: 100,
      height: 100,
      fonts: [{ ...FONT, variationCoordinates: { wght: 400 } }],
    });
    const b = computeRenderLayerCacheKey(layer, {
      width: 100,
      height: 100,
      fonts: [{ ...FONT, variationCoordinates: { wght: 700 } }],
    });
    expect(a).not.toBe(b);
  });
});
