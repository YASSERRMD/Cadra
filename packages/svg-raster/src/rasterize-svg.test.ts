import { describe, expect, it } from "vitest";

import { rasterizeSvg } from "./rasterize-svg.js";

const RED_CIRCLE_SVG = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="40" fill="rgba(255,0,0,0.5)"/>
</svg>`;

const RECT_SVG_400x200 = `<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="400" height="200" fill="blue"/>
</svg>`;

describe("rasterizeSvg", () => {
  it("rasterizes to the SVG's own natural size when no width/height is given", () => {
    const result = rasterizeSvg(RED_CIRCLE_SVG);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    expect(result.pixels).toHaveLength(100 * 100 * 4);
  });

  it("scales uniformly when only width is given, inferring height from the source aspect ratio", () => {
    const result = rasterizeSvg(RECT_SVG_400x200, { width: 800 });
    expect(result.width).toBe(800);
    expect(result.height).toBe(400);
  });

  it("accepts an explicit width and height consistent with the source aspect ratio", () => {
    const result = rasterizeSvg(RECT_SVG_400x200, { width: 1600, height: 800 });
    expect(result.width).toBe(1600);
    expect(result.height).toBe(800);
    expect(result.pixels).toHaveLength(1600 * 800 * 4);
  });

  it("throws a clear error for a width/height combination inconsistent with the source aspect ratio", () => {
    expect(() => rasterizeSvg(RECT_SVG_400x200, { width: 800, height: 800 })).toThrow(/aspect ratio/);
  });

  it("returns straight (non-premultiplied) alpha, not resvg's own native premultiplied output", () => {
    const result = rasterizeSvg(RED_CIRCLE_SVG);
    const centerIndex = (50 * 100 + 50) * 4;
    // A 50%-alpha pure red fill: straight alpha keeps the true red channel
    // at full intensity regardless of coverage; only premultiplied output
    // would show a dimmed red channel here (empirically verified against
    // real resvg output during this module's own design).
    expect(result.pixels[centerIndex]).toBeGreaterThanOrEqual(253);
    expect(result.pixels[centerIndex + 1]).toBe(0);
    expect(result.pixels[centerIndex + 2]).toBe(0);
    expect(result.pixels[centerIndex + 3]).toBeGreaterThanOrEqual(120);
    expect(result.pixels[centerIndex + 3]).toBeLessThanOrEqual(135);
  });

  it("is fully transparent outside any painted shape", () => {
    const result = rasterizeSvg(RED_CIRCLE_SVG);
    const cornerIndex = 0;
    expect(result.pixels[cornerIndex + 3]).toBe(0);
  });

  it("is deterministic across repeated calls with the same inputs", () => {
    const first = rasterizeSvg(RED_CIRCLE_SVG, { width: 300, height: 300 });
    const second = rasterizeSvg(RED_CIRCLE_SVG, { width: 300, height: 300 });
    expect(Buffer.from(first.pixels).equals(Buffer.from(second.pixels))).toBe(true);
  });

  it("is deterministic with supersampling enabled too", () => {
    const first = rasterizeSvg(RED_CIRCLE_SVG, { width: 300, height: 300, supersample: 3 });
    const second = rasterizeSvg(RED_CIRCLE_SVG, { width: 300, height: 300, supersample: 3 });
    expect(Buffer.from(first.pixels).equals(Buffer.from(second.pixels))).toBe(true);
  });

  it("produces the requested output size regardless of the supersample factor", () => {
    const result = rasterizeSvg(RED_CIRCLE_SVG, { width: 300, height: 300, supersample: 4 });
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
    expect(result.pixels).toHaveLength(300 * 300 * 4);
  });

  it("produces smoothly graded (anti-aliased), not binary, alpha along the circle's own edge, at a supersample factor", () => {
    const result = rasterizeSvg(RED_CIRCLE_SVG, { width: 400, height: 400, supersample: 4 });
    // Collect every alpha value strictly between fully transparent and
    // fully opaque across the *whole* image (not just one scan line - a
    // horizontal scan exactly through a circle's own widest point crosses
    // its edge almost perpendicularly, an edge case with only a pixel or
    // so of transition regardless of anti-aliasing quality; scanning every
    // row instead is guaranteed to also cross the top/bottom of the
    // circle, where the boundary is nearly horizontal and the transition
    // band is wide): real anti-aliasing produces a broad range of
    // intermediate values somewhere along a curved edge, not a hard jump
    // from 0 to 255 everywhere.
    const intermediateAlphas = new Set<number>();
    for (let i = 3; i < result.pixels.length; i += 4) {
      const alpha = result.pixels[i] as number;
      if (alpha > 10 && alpha < 245) {
        intermediateAlphas.add(alpha);
      }
    }
    expect(intermediateAlphas.size).toBeGreaterThan(3);
  });

  it("renders a respectable approximation of a 4K layer's edges cleanly, without throwing or producing an undersized buffer", () => {
    const svg = `<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg">
      <circle cx="480" cy="270" r="200" fill="white"/>
    </svg>`;
    // A quarter of real 4K (3840x2160) to keep the test fast while still
    // exercising a large, supersampled render path.
    const result = rasterizeSvg(svg, { width: 1920, height: 1080, supersample: 2 });
    expect(result.width).toBe(1920);
    expect(result.height).toBe(1080);
    expect(result.pixels).toHaveLength(1920 * 1080 * 4);

    const centerIndex = (540 * 1920 + 960) * 4;
    expect(result.pixels[centerIndex + 3]).toBe(255);
  });
});
