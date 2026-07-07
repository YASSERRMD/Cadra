import { Resvg } from "@resvg/resvg-js";

import { downsamplePremultipliedRgba, unpremultiplyRgba } from "./rgba-pixel-math.js";

export interface RasterizeSvgOptions {
  /** Target output width in pixels. Defaults to the SVG's own natural (authored) width. */
  width?: number;
  /** Target output height in pixels. Defaults to the SVG's own natural (authored) height. */
  height?: number;
  /**
   * Renders at `width * supersample` by `height * supersample` first, then
   * box-filters down to the target size (see `rgba-pixel-math.ts`), for
   * crisper edges than resvg's own single-pass anti-aliasing alone -
   * particularly noticeable on text and thin strokes at high output
   * resolutions. An integer of `1` (the default) skips supersampling
   * entirely (a plain, cheaper single-pass render).
   */
  supersample?: number;
  /** A CSS color string, e.g. `"rgba(255,255,255,0.8)"`. Defaults to fully transparent, matching Satori's own output (a layer authors its own background as a styled element, not the SVG canvas itself). */
  background?: string;
}

/** A rasterized SVG: straight-alpha (see `unpremultiplyRgba`'s own doc) RGBA8 pixels, row-major, top-to-bottom - ready for direct GPU texture upload, the same convention `@cadra/text`'s `MsdfAtlasPage.pixels` already establishes. */
export interface RasterizedSvg {
  width: number;
  height: number;
  pixels: Uint8Array;
}

const ASPECT_RATIO_TOLERANCE_PX = 1;

/**
 * Rasterizes `svg` (typically Satori's own output, `@cadra/satori-layer`'s
 * `renderLayerToSvg`, though this accepts any valid SVG) to RGBA pixels via
 * resvg, a fast, deterministic, from-scratch SVG renderer with no browser
 * or Chromium involved.
 *
 * resvg has no native "stretch to an arbitrary width and height" mode (only
 * fit-by-width, fit-by-height, or a uniform zoom, all aspect-ratio-
 * preserving), so passing both `width` and `height` only ever scales
 * uniformly from the SVG's own natural size - if they are not consistent
 * with each other (within rounding), this throws rather than silently
 * returning pixels whose actual aspect ratio does not match the declared
 * `width`/`height`. In the intended use (rasterizing one layer at some
 * pixel multiple of the same base size it was authored/generated at,
 * e.g. for a higher-resolution composition), both dimensions are already
 * derived from that one common scale factor, so this never triggers.
 *
 * Deterministic for the same `svg` and `options`: resvg is a pure function
 * of its own inputs, with no system-font substitution risk here since a
 * layer's own fonts are already embedded as glyph outlines directly in the
 * SVG (Satori's default `embedFont` behavior) rather than referenced by
 * name.
 */
export function rasterizeSvg(svg: string, options: RasterizeSvgOptions = {}): RasterizedSvg {
  const supersample = Math.max(1, Math.round(options.supersample ?? 1));

  const naturalSizeProbe = new Resvg(svg);
  const naturalWidth = naturalSizeProbe.width;
  const naturalHeight = naturalSizeProbe.height;

  const targetWidth = Math.max(1, Math.round(options.width ?? (naturalWidth / naturalHeight) * (options.height ?? naturalHeight)));
  const targetHeight = Math.max(1, Math.round(options.height ?? (naturalHeight / naturalWidth) * targetWidth));

  const expectedHeightForWidth = (naturalHeight / naturalWidth) * targetWidth;
  if (Math.abs(expectedHeightForWidth - targetHeight) > ASPECT_RATIO_TOLERANCE_PX) {
    throw new Error(
      `rasterizeSvg: requested ${targetWidth}x${targetHeight} is not consistent with this SVG's own ` +
        `${naturalWidth}x${naturalHeight} aspect ratio (expected height close to ${expectedHeightForWidth.toFixed(2)} ` +
        `for width ${targetWidth}). resvg cannot stretch to an arbitrary width and height; pass only one of ` +
        "width/height to scale uniformly, or supply values consistent with the source aspect ratio.",
    );
  }

  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: targetWidth * supersample },
    ...(options.background !== undefined && { background: options.background }),
  });
  const rendered = resvg.render();

  const downsampled = downsamplePremultipliedRgba(
    rendered.pixels,
    rendered.width,
    rendered.height,
    targetWidth,
    targetHeight,
  );

  return {
    width: targetWidth,
    height: targetHeight,
    pixels: unpremultiplyRgba(downsampled),
  };
}
