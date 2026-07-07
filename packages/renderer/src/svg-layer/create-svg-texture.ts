// From the browser-safe entry, not the bare "@cadra/svg-raster" barrel:
// this module is part of packages/renderer's own code path that
// packages/headless bundles into the browser-executed render page (via
// esbuild); the main "." entry pulls in @resvg/resvg-js, a native Node
// addon with no browser build at all. See @cadra/svg-raster's own
// browser.ts module doc for the full explanation.
import type { RasterizedSvg } from "@cadra/svg-raster/browser";
import * as THREE from "three";

/**
 * Wraps an already-rasterized SVG (`@cadra/svg-raster`'s `rasterizeSvg`,
 * run ahead of time - see this module's own import comment) into a
 * `THREE.DataTexture` ready for compositing: the CPU-buffer-to-GPU-texture
 * half of Phase 47's own "produce both a CPU buffer and a GPU texture
 * path" task, mirroring exactly how `../text/build-text-group.ts` wraps an
 * MSDF atlas page's own `pixels` the same way.
 *
 * `colorSpace` is set to `THREE.SRGBColorSpace`, not left at
 * `THREE.NoColorSpace` (three.js's own default for a `DataTexture`):
 * `rasterizeSvg`'s pixels are real, visible sRGB-gamma-encoded color (SVG
 * colors are authored in sRGB, the CSS/web standard color space), unlike
 * an MSDF atlas page's own RGB channels (a distance field, not color at
 * all, correctly left with no color space applied). Marking this now,
 * before Phase 54's linear-color/ACES pipeline exists, is exactly what
 * being "correct for compositing" with that not-yet-built pipeline means:
 * a texture tagged with its true source color space needs no rework once
 * that pipeline starts correctly converting every sRGB input to linear
 * before shading.
 */
export function createSvgTexture(rasterized: RasterizedSvg): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    rasterized.pixels,
    rasterized.width,
    rasterized.height,
    THREE.RGBAFormat,
  );
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
