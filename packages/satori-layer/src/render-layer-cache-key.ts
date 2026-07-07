import { type ContentHash, hashAssetBytes } from "@cadra/core";

import type { LayerElement } from "./layer-element.js";
import type { RenderLayerToSvgOptions } from "./render-layer-to-svg.js";

/**
 * Recursively re-serializes `value` with every plain object's own keys
 * sorted, so two values that are structurally identical except for the
 * order their properties were authored in stringify identically. Plain
 * `JSON.stringify` preserves insertion order, which would otherwise make
 * `computeRenderLayerCacheKey` (and so any cache keyed by it) miss a cache
 * hit for two `LayerElement` trees an author considers the same layer just
 * because, say, a style object's `color` and `fontSize` were written in
 * the other order.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const entries = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic cache key for one `renderLayerToSvg` request: the layer
 * tree and dimensions (order-independent, see `stableStringify`) plus every
 * font's own content hash and resolved weight/style/variation coordinates
 * (not the font's full bytes, already content-addressed by `contentHash`).
 */
export function computeRenderLayerCacheKey(
  layer: LayerElement,
  options: RenderLayerToSvgOptions,
): ContentHash {
  const fontsKey = options.fonts
    .map((layerFont) =>
      stableStringify({
        family: layerFont.family,
        contentHash: layerFont.font.contentHash,
        weight: layerFont.weight ?? 400,
        style: layerFont.style ?? "normal",
        variationCoordinates: layerFont.variationCoordinates ?? {},
      }),
    )
    .join(",");
  const dimensionsKey = stableStringify({
    width: "width" in options ? options.width : undefined,
    height: "height" in options ? options.height : undefined,
  });

  return hashAssetBytes(
    new TextEncoder().encode(`${stableStringify(layer)}:${dimensionsKey}:${fontsKey}`),
  );
}
