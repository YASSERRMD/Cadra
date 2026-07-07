import { describe, expect, it } from "vitest";

import type { TextStaggerConfig } from "../scene-graph/scene-node.js";
import { computeStaggerRanks, resolveTextUnitState } from "./text-stagger.js";

describe("computeStaggerRanks", () => {
  it("forward: rank equals unit index", () => {
    expect(computeStaggerRanks(4, "forward")).toEqual([0, 1, 2, 3]);
  });

  it("backward: rank is reversed", () => {
    expect(computeStaggerRanks(4, "backward")).toEqual([3, 2, 1, 0]);
  });

  it("centerOut: the middle unit(s) start first, rippling symmetrically outward (odd count)", () => {
    // 5 units, indices 0..4, center = 2. Distances: 2,1,0,1,2. Sorted by
    // distance (ties broken toward the lower index): 2,1,3,0,4 -> that is
    // each index's own rank, e.g. index 2 (distance 0) gets rank 0.
    expect(computeStaggerRanks(5, "centerOut")).toEqual([3, 1, 0, 2, 4]);
  });

  it("centerOut: even unit count, the two middle units tie-break to the lower index first", () => {
    // 4 units, indices 0..3, center = 1.5. Distances: 1.5, 0.5, 0.5, 1.5.
    // Sorted by distance (ties broken toward the lower index): 1,2,0,3.
    expect(computeStaggerRanks(4, "centerOut")).toEqual([2, 0, 1, 3]);
  });

  it("produces a dense permutation of 0..unitCount-1 for every direction", () => {
    for (const direction of ["forward", "backward", "centerOut"] as const) {
      const ranks = computeStaggerRanks(7, direction);
      expect([...ranks].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });
});

const LINE_REVEAL: TextStaggerConfig = {
  preset: "lineReveal",
  grouping: "line",
  startFrame: 10,
  delayFrames: 5,
  durationFrames: 10,
};

describe("resolveTextUnitState: lineReveal/typewriter (opacity-only reveal)", () => {
  it("holds opacity 0 before the unit's own start frame", () => {
    expect(resolveTextUnitState(LINE_REVEAL, 0, 9)).toEqual({ opacity: 0 });
  });

  it("resolves opacity 0.5 exactly halfway through the unit's own reveal window", () => {
    expect(resolveTextUnitState(LINE_REVEAL, 0, 15).opacity).toBeCloseTo(0.5, 5);
  });

  it("holds opacity 1 after the unit's own reveal window ends", () => {
    expect(resolveTextUnitState(LINE_REVEAL, 0, 30)).toEqual({ opacity: 1 });
  });

  it("offsets a later-rank unit's own start frame by rank * delayFrames", () => {
    // rank 2: starts at startFrame + 2*delayFrames = 10 + 10 = 20, so its
    // own reveal window is [20, 30] - frame 25 is its own midpoint.
    expect(resolveTextUnitState(LINE_REVEAL, 2, 19)).toEqual({ opacity: 0 });
    expect(resolveTextUnitState(LINE_REVEAL, 2, 25).opacity).toBeCloseTo(0.5, 5);
  });

  it("never sets offsetY", () => {
    expect(resolveTextUnitState(LINE_REVEAL, 0, 15)).not.toHaveProperty("offsetY");
  });

  it("applies a non-default easing curve, producing a different mid-point than linear", () => {
    const eased: TextStaggerConfig = { ...LINE_REVEAL, easing: "easeInCubic" };
    const linearMid = resolveTextUnitState(LINE_REVEAL, 0, 15).opacity as number;
    const easedMid = resolveTextUnitState(eased, 0, 15).opacity as number;
    expect(linearMid).toBeCloseTo(0.5, 5);
    expect(easedMid).toBeCloseTo(0.125, 5); // easeInCubic(0.5) = 0.5^3
    expect(easedMid).not.toBeCloseTo(linearMid, 2);
  });

  it("typewriter resolves identically to lineReveal (opacity-only, same reveal math)", () => {
    const typewriter: TextStaggerConfig = { ...LINE_REVEAL, preset: "typewriter" };
    expect(resolveTextUnitState(typewriter, 1, 17)).toEqual(resolveTextUnitState({ ...LINE_REVEAL, preset: "lineReveal" }, 1, 17));
  });
});

const FADE_IN_UP: TextStaggerConfig = {
  preset: "fadeInUp",
  grouping: "word",
  startFrame: 0,
  delayFrames: 3,
  durationFrames: 10,
  distance: 1,
};

describe("resolveTextUnitState: fadeInUp (opacity plus a decaying offsetY)", () => {
  it("starts fully offset and transparent before its own reveal window", () => {
    expect(resolveTextUnitState(FADE_IN_UP, 0, -1)).toEqual({ opacity: 0, offsetY: -1 });
  });

  it("ends at zero offset and full opacity once its own reveal window completes", () => {
    expect(resolveTextUnitState(FADE_IN_UP, 0, 10)).toEqual({ opacity: 1, offsetY: 0 });
  });

  it("offsetY decays proportionally to (1 - progress) at the midpoint", () => {
    const state = resolveTextUnitState(FADE_IN_UP, 0, 5);
    expect(state.opacity).toBeCloseTo(0.5, 5);
    expect(state.offsetY).toBeCloseTo(-0.5, 5);
  });

  it("defaults distance to 0.5 when omitted", () => {
    const { distance: _distance, ...withoutDistance } = FADE_IN_UP;
    expect(resolveTextUnitState(withoutDistance, 0, -1).offsetY).toBeCloseTo(-0.5, 5);
  });
});

const WAVE: TextStaggerConfig = {
  preset: "wave",
  grouping: "character",
  startFrame: 0,
  delayFrames: 2,
  durationFrames: 0,
  amplitude: 2,
  periodFrames: 20,
};

describe("resolveTextUnitState: wave (continuous, rank-phase-shifted oscillation)", () => {
  it("sits at rest before the unit's own start frame", () => {
    expect(resolveTextUnitState(WAVE, 0, -1)).toEqual({ offsetY: 0 });
  });

  it("oscillates sinusoidally after its own start frame, peaking at one quarter-period", () => {
    // sin(2*pi * (5/20)) = sin(pi/2) = 1, so offsetY should hit the full amplitude.
    expect(resolveTextUnitState(WAVE, 0, 5).offsetY).toBeCloseTo(2, 5);
  });

  it("never sets opacity", () => {
    expect(resolveTextUnitState(WAVE, 0, 5)).not.toHaveProperty("opacity");
  });

  it("phase-shifts a later rank's oscillation by rank * delayFrames", () => {
    // rank 1 starts 2 frames later (delayFrames=2), so its own frame-5 state
    // matches rank 0's frame-3 state (5 - 2 = 3).
    const rank1AtFrame5 = resolveTextUnitState(WAVE, 1, 5);
    const rank0AtFrame3 = resolveTextUnitState(WAVE, 0, 3);
    expect(rank1AtFrame5.offsetY).toBeCloseTo(rank0AtFrame3.offsetY as number, 10);
  });

  it("is continuous, never settling: evaluating far past the start frame keeps oscillating rather than clamping", () => {
    const farFuture = resolveTextUnitState(WAVE, 0, 5 + 20 * 100);
    expect(farFuture.offsetY).toBeCloseTo(2, 5);
  });
});

describe("resolveTextUnitState: determinism", () => {
  it("resolving the same (config, rank, frame) repeatedly always gives the same result", () => {
    const first = resolveTextUnitState(FADE_IN_UP, 3, 7);
    const second = resolveTextUnitState(FADE_IN_UP, 3, 7);
    expect(second).toEqual(first);
  });

  it("evaluating frames out of order gives the same result as evaluating in order", () => {
    const inOrder = [0, 5, 10, 15].map((frame) => resolveTextUnitState(WAVE, 2, frame));
    const outOfOrder = [15, 0, 10, 5].map((frame) => resolveTextUnitState(WAVE, 2, frame));
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[3]).toEqual(inOrder[1]);
    expect(outOfOrder[2]).toEqual(inOrder[2]);
    expect(outOfOrder[0]).toEqual(inOrder[3]);
  });
});
