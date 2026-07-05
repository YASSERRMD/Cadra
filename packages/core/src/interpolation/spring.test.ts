import { describe, expect, it } from "vitest";

import { spring } from "./spring.js";

const FPS = 30;

describe("spring", () => {
  it("returns config.from immediately at frame 0 (t <= 0)", () => {
    expect(spring(0, FPS, { from: 5, to: 20 })).toBe(5);
  });

  it("returns config.from immediately for negative frames", () => {
    expect(spring(-10, FPS, { from: 5, to: 20 })).toBe(5);
  });

  it("uses default config (mass 1, stiffness 100, damping 10, from 0, to 1) when omitted", () => {
    const result = spring(15, FPS);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1.5);
  });

  it("calling spring(frame, fps, config) twice for the same frame returns the exact same number", () => {
    const config = { mass: 1, stiffness: 180, damping: 12, from: 0, to: 1 };
    const first = spring(42, FPS, config);
    const second = spring(42, FPS, config);
    expect(first).toBe(second);
  });

  it("has no shared/leaked state between calls: out-of-order evaluation matches direct evaluation", () => {
    const config = { mass: 1, stiffness: 150, damping: 15, from: 0, to: 1 };

    const frame500First = spring(500, FPS, config);
    // Interleave a call for an unrelated, earlier frame in between.
    const frame10 = spring(10, FPS, config);
    const frame500Second = spring(500, FPS, config);

    expect(frame500First).toBe(frame500Second);
    // Sanity: frame 10 is a distinct, legitimately different value, not a
    // trivially-equal placeholder.
    expect(frame10).not.toBe(frame500First);
  });

  it("matches evaluating frames 0..500 in order and inspecting frame 500 in isolation", () => {
    const config = { mass: 1, stiffness: 120, damping: 14, from: 2, to: 9 };

    let lastInOrderValue = Number.NaN;
    for (let frame = 0; frame <= 500; frame += 1) {
      lastInOrderValue = spring(frame, FPS, config);
    }

    const isolated = spring(500, FPS, config);
    expect(isolated).toBe(lastInOrderValue);
  });

  it("produces identical results across many repeated calls for the same input (determinism proof)", () => {
    const config = { mass: 1.2, stiffness: 200, damping: 20, from: -5, to: 5 };
    const reference = spring(77, FPS, config);
    for (let i = 0; i < 200; i += 1) {
      expect(spring(77, FPS, config)).toBe(reference);
    }
  });

  it("converges toward config.to for a critically damped config after a couple of seconds", () => {
    // Critical damping for mass=1, stiffness=100 is damping = 2*sqrt(k*m) = 20.
    const config = { mass: 1, stiffness: 100, damping: 20, from: 0, to: 10 };
    const result = spring(FPS * 3, FPS, config);
    expect(result).toBeCloseTo(10, 1);
  });

  it("converges toward config.to for an overdamped config after a couple of seconds", () => {
    const config = { mass: 1, stiffness: 100, damping: 40, from: 0, to: 10 };
    const result = spring(FPS * 4, FPS, config);
    expect(result).toBeCloseTo(10, 1);
  });

  it("converges toward config.to for an underdamped config after a couple of seconds (despite oscillation)", () => {
    const config = { mass: 1, stiffness: 100, damping: 5, from: 0, to: 10 };
    const result = spring(FPS * 4, FPS, config);
    expect(result).toBeCloseTo(10, 0.5);
  });

  it("underdamped config overshoots config.to at some point before settling", () => {
    const config = { mass: 1, stiffness: 100, damping: 3, from: 0, to: 10 };
    let maxValue = -Infinity;
    for (let frame = 0; frame <= FPS * 2; frame += 1) {
      maxValue = Math.max(maxValue, spring(frame, FPS, config));
    }
    expect(maxValue).toBeGreaterThan(10);
  });

  it("monotonically approaches config.to for a heavily overdamped config (no overshoot)", () => {
    const config = { mass: 1, stiffness: 100, damping: 60, from: 0, to: 10 };
    let maxValue = -Infinity;
    for (let frame = 0; frame <= FPS * 5; frame += 1) {
      maxValue = Math.max(maxValue, spring(frame, FPS, config));
    }
    // Overdamped systems approach the target from below without overshoot.
    expect(maxValue).toBeLessThanOrEqual(10 + 1e-6);
  });

  it("remaps normalized position into an arbitrary [from, to] range", () => {
    const config = { mass: 1, stiffness: 100, damping: 20, from: 100, to: 200 };
    const early = spring(1, FPS, config);
    const late = spring(FPS * 3, FPS, config);
    expect(early).toBeGreaterThanOrEqual(100);
    expect(late).toBeCloseTo(200, 1);
  });

  it("handles from > to (a downward-settling spring)", () => {
    const config = { mass: 1, stiffness: 100, damping: 20, from: 10, to: 0 };
    const late = spring(FPS * 3, FPS, config);
    expect(late).toBeCloseTo(0, 1);
  });

  it("is independent of fps for a fixed elapsed time (same t = frame / fps gives the same result)", () => {
    const config = { mass: 1, stiffness: 100, damping: 20, from: 0, to: 1 };
    const atFps30 = spring(30, 30, config);
    const atFps60 = spring(60, 60, config);
    // Both correspond to t = 1 second.
    expect(atFps30).toBeCloseTo(atFps60, 6);
  });
});
