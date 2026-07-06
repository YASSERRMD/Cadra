import { describe, expect, it } from "vitest";

import { computeAspectFitSize } from "./aspect-fit.js";

describe("computeAspectFitSize", () => {
  it("pillarboxes (binds height, shrinks width) when the container is wider than the composition's ratio", () => {
    // Composition 4:3 (ratio 1.333), container 21:9 (2100x900, ratio 2.333):
    // container is relatively much wider than the composition, so height
    // binds to the container's full height and width shrinks.
    const size = computeAspectFitSize({ width: 2100, height: 900 }, { width: 800, height: 600 });
    expect(size.height).toBe(900);
    expect(size.width).toBeCloseTo(1200, 5); // 900 * (800/600) = 1200
  });

  it("letterboxes (binds width, shrinks height) when the container is narrower than the composition's ratio", () => {
    // Composition 16:9 (1920x1080, ratio 1.778), container 4:3 (800x600,
    // ratio 1.333): container is relatively narrower, so width binds to the
    // container's full width and height shrinks below the container's.
    const size = computeAspectFitSize({ width: 800, height: 600 }, { width: 1920, height: 1080 });
    expect(size.width).toBe(800);
    expect(size.height).toBeCloseTo(450, 5); // 800 / (1920/1080) = 450
  });

  it("fits exactly, with no letterboxing or pillarboxing, when the ratios match exactly", () => {
    const size = computeAspectFitSize({ width: 1280, height: 720 }, { width: 1920, height: 1080 });
    expect(size.width).toBe(1280);
    expect(size.height).toBe(720);
  });

  it("scales up to fill a container larger than the composition, preserving ratio", () => {
    const size = computeAspectFitSize({ width: 3840, height: 2160 }, { width: 1920, height: 1080 });
    expect(size.width).toBe(3840);
    expect(size.height).toBe(2160);
  });

  it("handles a square composition inside a wide container by pillarboxing", () => {
    const size = computeAspectFitSize({ width: 1000, height: 500 }, { width: 400, height: 400 });
    expect(size.height).toBe(500);
    expect(size.width).toBe(500);
  });

  it("handles a square composition inside a tall container by letterboxing", () => {
    const size = computeAspectFitSize({ width: 500, height: 1000 }, { width: 400, height: 400 });
    expect(size.width).toBe(500);
    expect(size.height).toBe(500);
  });

  it("returns zero size when the container has zero width (not yet laid out)", () => {
    const size = computeAspectFitSize({ width: 0, height: 900 }, { width: 1920, height: 1080 });
    expect(size).toEqual({ width: 0, height: 0 });
  });

  it("returns zero size when the container has zero height", () => {
    const size = computeAspectFitSize({ width: 1600, height: 0 }, { width: 1920, height: 1080 });
    expect(size).toEqual({ width: 0, height: 0 });
  });

  it("returns zero size when the composition has a non-positive dimension", () => {
    const size = computeAspectFitSize({ width: 1600, height: 900 }, { width: 0, height: 1080 });
    expect(size).toEqual({ width: 0, height: 0 });
  });
});
