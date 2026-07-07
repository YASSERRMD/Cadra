import type { ParsedFont } from "@cadra/text";
import type { ReactNode } from "react";
import type { FontStyle, FontWeight, SatoriOptions } from "satori";
import satori from "satori";

import type { LayerElement } from "./layer-element.js";
import { layerElementToSatoriNode, type SatoriElement } from "./layer-to-satori-node.js";
import { instanceFontForSatori } from "./satori-font-instancing.js";

/**
 * Satori's own exported signature takes `ReactNode` (a real React project's
 * type, since Satori is most commonly driven by real JSX). This package
 * never uses JSX or the `react` runtime at all (see `SatoriElement`'s own
 * doc: Satori documents plain `{type, props}` objects as a fully supported
 * alternative), so `SatoriElement` intentionally does not carry React's
 * `ReactElement`-specific fields (`key`, a distinct top-level `children`)
 * that a real React app would never construct by hand either. This one
 * cast (through `unknown`, since the two types otherwise do not overlap)
 * is the single, documented seam between this package's own typed surface
 * and Satori's React-shaped one.
 */
function callSatori(node: SatoriElement, options: SatoriOptions): Promise<string> {
  return satori(node as unknown as ReactNode, options);
}

/**
 * One font a layer's styles can select via `fontFamily` (matched against
 * `family`) plus `fontWeight`/`fontStyle` (matched against `weight`/
 * `style`, both defaulting to `400`/`"normal"` same as real CSS) - the
 * bridge between Phase 41's font registry (`ParsedFont`, resolved by
 * whatever calls `renderLayerToSvg`, e.g. a scene's own font references)
 * and Satori's own `fonts` option.
 */
export interface SatoriLayerFont {
  family: string;
  font: ParsedFont;
  weight?: FontWeight;
  style?: FontStyle;
  /**
   * Explicit variation coordinates for this font (e.g. `{ wght: 700 }` for
   * a bold weight drawn from one variable font file rather than a separate
   * static file). Axes not mentioned default to the font's own declared
   * default; see `resolveFullVariationPin`.
   */
  variationCoordinates?: Readonly<Record<string, number>>;
}

/** Satori requires at least one of `width`/`height` (the other is inferred to preserve aspect ratio); this mirrors that union exactly rather than making both optional. */
export type LayerDimensions = { width: number; height: number } | { width: number } | { height: number };

export type RenderLayerToSvgOptions = LayerDimensions & {
  fonts: readonly SatoriLayerFont[];
};

/** Recursively concatenates every string leaf under `element`, in document order: every font is subset against this same shared text rather than a per-font-selector-matched subset (simpler, and safe - a wider subset than strictly needed for one particular font is never a correctness problem, only a (minor) output-size one). */
function collectAllText(element: LayerElement): string {
  let text = "";
  for (const child of element.children ?? []) {
    text += typeof child === "string" ? child : collectAllText(child);
  }
  return text;
}

/**
 * Renders a `LayerElement` tree to an SVG string via Satori, Vercel's
 * from-scratch HTML/CSS-to-SVG layout and rendering engine (real flexbox
 * layout via Yoga, no browser or Chromium involved at all).
 *
 * Each of `options.fonts` is prepared via `instanceFontForSatori` first:
 * Satori's own font parser cannot read a variable font at all (see that
 * function's own doc), so every font is pinned to a fully static instance
 * and subset down to the layer's own text before Satori ever sees it.
 *
 * Deterministic for the same `layer` plus the same `options`: Satori
 * itself is a pure function of its inputs (verified empirically: identical
 * repeated calls with the same element tree and fonts produce byte-
 * identical SVG output), and so is HarfBuzz's own font subsetting/
 * instancing this relies on to prepare each font.
 */
export async function renderLayerToSvg(
  layer: LayerElement,
  options: RenderLayerToSvgOptions,
): Promise<string> {
  const text = collectAllText(layer);

  const instancedFonts = await Promise.all(
    options.fonts.map(async (layerFont) => ({
      name: layerFont.family,
      data: Buffer.from(await instanceFontForSatori(layerFont.font, text, layerFont.variationCoordinates)),
      weight: layerFont.weight ?? 400,
      style: layerFont.style ?? "normal",
    })),
  );

  const node = layerElementToSatoriNode(layer);
  const dimensions: LayerDimensions =
    "width" in options && "height" in options
      ? { width: options.width, height: options.height }
      : "width" in options
        ? { width: options.width }
        : { height: options.height };

  return callSatori(node, { ...dimensions, fonts: instancedFonts });
}
