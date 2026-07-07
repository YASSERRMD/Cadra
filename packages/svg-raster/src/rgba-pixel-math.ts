/**
 * Averages `source` (premultiplied-alpha RGBA8, `sourceWidth` x `sourceHeight`)
 * down to `targetWidth` x `targetHeight` by a box filter: each output
 * pixel's block boundaries are its own row/column index times the (not
 * necessarily whole-number) source-to-target ratio, rounded to the nearest
 * source pixel - an exact, non-overlapping, gap-free partition of the
 * source when the ratio is a whole number (`rasterizeSvg`'s own intended
 * use, a whole-number `supersample` factor), and still a sound area-
 * average when it is not (e.g. resvg's own internal aspect-ratio rounding
 * making its actual rendered size differ from the requested one by a
 * pixel or two).
 *
 * Operates in premultiplied-alpha space deliberately: resvg's own
 * `RenderedImage.pixels` output is premultiplied (verified empirically - a
 * 50%-alpha pure red fill over nothing rendered as RGBA `(127, 0, 0, 127)`,
 * not `(255, 0, 0, 127)`), and premultiplied values are the ones safe to
 * linearly average - averaging straight-alpha RGB independently of alpha
 * produces visibly wrong (dark-fringed) colors at any partially-transparent
 * edge, exactly where supersampling's anti-aliasing benefit matters most
 * (e.g. text edges). `unpremultiplyRgba` converts the final result back to
 * straight alpha once, after averaging, not per source pixel.
 */
export function downsamplePremultipliedRgba(
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    return source.slice();
  }

  const blockWidth = sourceWidth / targetWidth;
  const blockHeight = sourceHeight / targetHeight;
  const target = new Uint8Array(targetWidth * targetHeight * 4);

  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const sourceYStart = Math.round(targetY * blockHeight);
    const sourceYEnd = Math.round((targetY + 1) * blockHeight);
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const sourceXStart = Math.round(targetX * blockWidth);
      const sourceXEnd = Math.round((targetX + 1) * blockWidth);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sourceY = sourceYStart; sourceY < sourceYEnd; sourceY += 1) {
        for (let sourceX = sourceXStart; sourceX < sourceXEnd; sourceX += 1) {
          const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
          r += source[sourceIndex] as number;
          g += source[sourceIndex + 1] as number;
          b += source[sourceIndex + 2] as number;
          a += source[sourceIndex + 3] as number;
          count += 1;
        }
      }

      const targetIndex = (targetY * targetWidth + targetX) * 4;
      target[targetIndex] = Math.round(r / count);
      target[targetIndex + 1] = Math.round(g / count);
      target[targetIndex + 2] = Math.round(b / count);
      target[targetIndex + 3] = Math.round(a / count);
    }
  }

  return target;
}

/**
 * Converts premultiplied-alpha RGBA8 pixels (resvg's own native output
 * format, see `downsamplePremultipliedRgba`'s own doc) to straight alpha:
 * the standard convention any other image texture in this codebase uses
 * (a `THREE.Texture`'s default `premultiplyAlpha` is `false`), so this
 * package's own output composites correctly without callers needing any
 * special-cased blending just for SVG-rasterized layers.
 */
export function unpremultiplyRgba(pixels: Uint8Array): Uint8Array {
  const result = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] as number;
    if (alpha === 0) {
      continue;
    }
    result[i] = Math.min(255, Math.round(((pixels[i] as number) * 255) / alpha));
    result[i + 1] = Math.min(255, Math.round(((pixels[i + 1] as number) * 255) / alpha));
    result[i + 2] = Math.min(255, Math.round(((pixels[i + 2] as number) * 255) / alpha));
    result[i + 3] = alpha;
  }
  return result;
}
