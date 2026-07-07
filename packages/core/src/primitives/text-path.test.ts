import { describe, expect, it } from "vitest";

import type { TextPathConfig } from "../scene-graph/scene-node.js";
import { createTextPathSampler, resolveTextPath } from "./text-path.js";

describe("resolveTextPath: defaults", () => {
  const MINIMAL: TextPathConfig = {
    start: [0, 0, 0],
    segments: [{ type: "line", to: [10, 0, 0] }],
  };

  it("defaults progress to 1, startOffset to 0, orientation to tangent, spacing to advance, alignment to start", () => {
    const resolved = resolveTextPath(MINIMAL, 0);
    expect(resolved.progress).toBe(1);
    expect(resolved.startOffset).toBe(0);
    expect(resolved.orientation).toBe("tangent");
    expect(resolved.spacing).toBe("advance");
    expect(resolved.alignment).toBe("start");
  });

  it("resolves keyframed control points, so a path can deform across frames", () => {
    const deforming: TextPathConfig = {
      start: [0, 0, 0],
      segments: [
        {
          type: "line",
          to: {
            type: "keyframeTrack",
            keyframes: [
              { frame: 0, value: [10, 0, 0] },
              { frame: 10, value: [10, 5, 0] },
            ],
          },
        },
      ],
    };
    const atFrame0 = resolveTextPath(deforming, 0);
    const atFrame10 = resolveTextPath(deforming, 10);
    expect(atFrame0.segments[0]).toEqual({ type: "line", to: [10, 0, 0] });
    expect(atFrame10.segments[0]).toEqual({ type: "line", to: [10, 5, 0] });
  });
});

describe("createTextPathSampler: a single line segment", () => {
  const path = resolveTextPath({ start: [0, 0, 0], segments: [{ type: "line", to: [10, 0, 0] }] }, 0);
  const sampler = createTextPathSampler(path);

  it("has the segment's own straight-line length", () => {
    expect(sampler.totalLength).toBeCloseTo(10, 10);
  });

  it("samples the start point at u=0 and the end point at u=1", () => {
    expect(sampler.sampleAt(0).point).toEqual([0, 0, 0]);
    expect(sampler.sampleAt(1).point).toEqual([10, 0, 0]);
  });

  it("samples the midpoint at u=0.5", () => {
    const sample = sampler.sampleAt(0.5);
    expect(sample.point[0]).toBeCloseTo(5, 10);
    expect(sample.point[1]).toBeCloseTo(0, 10);
  });

  it("gives a tangent pointing straight along the line's own direction", () => {
    expect(sampler.sampleAt(0.5).tangent).toEqual([1, 0, 0]);
  });

  it("clamps u outside [0, 1]", () => {
    expect(sampler.sampleAt(-1).point).toEqual([0, 0, 0]);
    expect(sampler.sampleAt(2).point).toEqual([10, 0, 0]);
  });
});

describe("createTextPathSampler: a quadratic bezier segment", () => {
  // P0=(0,0,0), control=(5,10,0), P2=(10,0,0): a known symmetric arch.
  const path = resolveTextPath(
    { start: [0, 0, 0], segments: [{ type: "quadratic", control: [5, 10, 0], to: [10, 0, 0] }] },
    0,
  );
  const sampler = createTextPathSampler(path);

  it("passes through both endpoints", () => {
    expect(sampler.sampleAt(0).point[0]).toBeCloseTo(0, 5);
    expect(sampler.sampleAt(0).point[1]).toBeCloseTo(0, 5);
    expect(sampler.sampleAt(1).point[0]).toBeCloseTo(10, 5);
    expect(sampler.sampleAt(1).point[1]).toBeCloseTo(0, 5);
  });

  it("peaks at its own midpoint, matching the standard Bezier formula (verified by hand: (5, 5, 0) at t=0.5)", () => {
    // A symmetric arch's own arc-length midpoint coincides with its
    // parametric midpoint (t=0.5) by symmetry.
    const sample = sampler.sampleAt(0.5);
    expect(sample.point[0]).toBeCloseTo(5, 1);
    expect(sample.point[1]).toBeCloseTo(5, 1);
  });

  it("is longer than the straight-line distance between its own endpoints (it actually curves)", () => {
    const straightLineDistance = 10;
    expect(sampler.totalLength).toBeGreaterThan(straightLineDistance);
  });
});

describe("createTextPathSampler: a cubic bezier segment", () => {
  const path = resolveTextPath(
    {
      start: [0, 0, 0],
      segments: [{ type: "cubic", control1: [3, 10, 0], control2: [7, 10, 0], to: [10, 0, 0] }],
    },
    0,
  );
  const sampler = createTextPathSampler(path);

  it("passes through both endpoints", () => {
    expect(sampler.sampleAt(0).point[0]).toBeCloseTo(0, 5);
    expect(sampler.sampleAt(1).point[0]).toBeCloseTo(10, 5);
  });

  it("is longer than the straight-line distance between its own endpoints", () => {
    expect(sampler.totalLength).toBeGreaterThan(10);
  });
});

describe("createTextPathSampler: multiple segments", () => {
  // Two 10-unit line segments end to end: (0,0,0) -> (10,0,0) -> (10,10,0).
  const path = resolveTextPath(
    {
      start: [0, 0, 0],
      segments: [
        { type: "line", to: [10, 0, 0] },
        { type: "line", to: [10, 10, 0] },
      ],
    },
    0,
  );
  const sampler = createTextPathSampler(path);

  it("sums every segment's own length", () => {
    expect(sampler.totalLength).toBeCloseTo(20, 10);
  });

  it("samples exactly at the joint between segments at u=0.5", () => {
    const sample = sampler.sampleAt(0.5);
    expect(sample.point[0]).toBeCloseTo(10, 10);
    expect(sample.point[1]).toBeCloseTo(0, 10);
  });

  it("samples within the first segment before the joint", () => {
    const sample = sampler.sampleAt(0.25);
    expect(sample.point[0]).toBeCloseTo(5, 10);
    expect(sample.point[1]).toBeCloseTo(0, 10);
  });

  it("samples within the second segment after the joint, with a rotated tangent", () => {
    const sample = sampler.sampleAt(0.75);
    expect(sample.point[0]).toBeCloseTo(10, 10);
    expect(sample.point[1]).toBeCloseTo(5, 10);
    expect(sample.tangent).toEqual([0, 1, 0]);
  });
});

describe("createTextPathSampler: degenerate paths", () => {
  it("handles a path with no segments at all (a single point)", () => {
    const path = resolveTextPath({ start: [1, 2, 3], segments: [] }, 0);
    const sampler = createTextPathSampler(path);
    expect(sampler.totalLength).toBe(0);
    expect(sampler.sampleAt(0.5).point).toEqual([1, 2, 3]);
    expect(sampler.sampleAt(0.5).tangent).toEqual([0, 0, 0]);
  });

  it("handles a segment whose start and end coincide (zero length)", () => {
    const path = resolveTextPath({ start: [5, 5, 5], segments: [{ type: "line", to: [5, 5, 5] }] }, 0);
    const sampler = createTextPathSampler(path);
    expect(sampler.totalLength).toBe(0);
    expect(() => sampler.sampleAt(0.5)).not.toThrow();
  });
});

describe("createTextPathSampler: determinism", () => {
  it("resolving and sampling the same path repeatedly gives the same result", () => {
    const config: TextPathConfig = {
      start: [0, 0, 0],
      segments: [{ type: "cubic", control1: [3, 10, 0], control2: [7, -10, 0], to: [10, 3, 0] }],
    };
    const firstSampler = createTextPathSampler(resolveTextPath(config, 5));
    const secondSampler = createTextPathSampler(resolveTextPath(config, 5));
    expect(secondSampler.sampleAt(0.37)).toEqual(firstSampler.sampleAt(0.37));
  });

  it("is deterministic and order-independent across frames, for a keyframe-deforming path", () => {
    const deforming: TextPathConfig = {
      start: [0, 0, 0],
      segments: [
        {
          type: "quadratic",
          control: [5, 10, 0],
          to: {
            type: "keyframeTrack",
            keyframes: [
              { frame: 0, value: [10, 0, 0] },
              { frame: 10, value: [10, 8, 0] },
            ],
          },
        },
      ],
    };
    const sampleAtFrame = (frame: number) => createTextPathSampler(resolveTextPath(deforming, frame)).sampleAt(0.6);

    const first = sampleAtFrame(7);
    const second = sampleAtFrame(7);
    expect(second).toEqual(first);

    const inOrder = [0, 5, 10].map(sampleAtFrame);
    const outOfOrder = [10, 0, 5].map(sampleAtFrame);
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[2]).toEqual(inOrder[1]);
    expect(outOfOrder[0]).toEqual(inOrder[2]);
  });
});
