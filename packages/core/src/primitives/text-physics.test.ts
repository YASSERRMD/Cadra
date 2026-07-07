import { describe, expect, it } from "vitest";

import type { TextPhysicsConfig } from "../scene-graph/scene-node.js";
import { resolveGlyphPhysicsState } from "./text-physics.js";

const SPRING: TextPhysicsConfig = {
  effect: "spring",
  grouping: "character",
  startFrame: 0,
  delayFrames: 5,
  fps: 30,
  distance: 1,
};

describe("resolveGlyphPhysicsState: spring", () => {
  it("starts fully offset, invisible, and at zero scale before its own start frame", () => {
    const state = resolveGlyphPhysicsState(SPRING, 0, 0);
    expect(state.offsetY).toBe(-1);
    expect(state.scale).toBe(0);
    expect(state.opacity).toBe(0);
  });

  it("settles close to natural position, full scale, and full opacity well after its own start frame", () => {
    const state = resolveGlyphPhysicsState(SPRING, 0, 90); // 3 seconds at 30fps
    expect(state.offsetY as number).toBeCloseTo(0, 1);
    expect(state.scale as number).toBeCloseTo(1, 1);
    expect(state.opacity as number).toBeCloseTo(1, 1);
  });

  it("clamps opacity to [0, 1] even while position/scale are free to overshoot", () => {
    // An underdamped spring (stiffness=100, damping=10, mass=1 - damping
    // ratio 0.5) overshoots past its target at some point during settling;
    // opacity must never follow it past 1 or below 0.
    let sawOvershoot = false;
    for (let frame = 0; frame <= 60; frame += 1) {
      const state = resolveGlyphPhysicsState(SPRING, 0, frame);
      if ((state.scale as number) > 1) {
        sawOvershoot = true;
      }
      expect(state.opacity as number).toBeGreaterThanOrEqual(0);
      expect(state.opacity as number).toBeLessThanOrEqual(1);
    }
    expect(sawOvershoot).toBe(true);
  });

  it("offsets a later-rank unit's own start frame by rank * delayFrames", () => {
    const rank2AtFrame4 = resolveGlyphPhysicsState(SPRING, 2, 4); // starts at frame 10
    expect(rank2AtFrame4.offsetY).toBe(-1); // has not started yet
  });

  it("is deterministic and order-independent", () => {
    const first = resolveGlyphPhysicsState(SPRING, 1, 20);
    const second = resolveGlyphPhysicsState(SPRING, 1, 20);
    expect(second).toEqual(first);

    const inOrder = [0, 10, 20].map((frame) => resolveGlyphPhysicsState(SPRING, 1, frame));
    const outOfOrder = [20, 0, 10].map((frame) => resolveGlyphPhysicsState(SPRING, 1, frame));
    expect(outOfOrder[1]).toEqual(inOrder[0]);
    expect(outOfOrder[2]).toEqual(inOrder[1]);
    expect(outOfOrder[0]).toEqual(inOrder[2]);
  });
});

const JITTER: TextPhysicsConfig = {
  effect: "jitter",
  grouping: "character",
  seed: 7,
  positionAmplitude: 0.5,
  rotationAmplitude: 0.2,
  periodFrames: 10,
};

describe("resolveGlyphPhysicsState: jitter", () => {
  it("stays within the configured position amplitude", () => {
    for (let frame = 0; frame < 50; frame += 1) {
      const state = resolveGlyphPhysicsState(JITTER, 0, frame);
      expect(Math.abs(state.offsetX as number)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(state.offsetY as number)).toBeLessThanOrEqual(0.5);
    }
  });

  it("sets rotationZ only when rotationAmplitude is nonzero", () => {
    const withRotation = resolveGlyphPhysicsState(JITTER, 0, 5);
    expect(withRotation.rotationZ).not.toBeUndefined();

    const withoutRotation = resolveGlyphPhysicsState({ ...JITTER, rotationAmplitude: 0 }, 0, 5);
    expect(withoutRotation.rotationZ).toBeUndefined();
  });

  it("never sets opacity or scale", () => {
    const state = resolveGlyphPhysicsState(JITTER, 0, 5);
    expect(state.opacity).toBeUndefined();
    expect(state.scale).toBeUndefined();
  });

  it("gives different ranks independent (uncorrelated) jitter", () => {
    const rank0 = resolveGlyphPhysicsState(JITTER, 0, 5);
    const rank1 = resolveGlyphPhysicsState(JITTER, 1, 5);
    expect(rank0.offsetX).not.toBe(rank1.offsetX);
  });

  it("is deterministic", () => {
    const first = resolveGlyphPhysicsState(JITTER, 3, 42);
    const second = resolveGlyphPhysicsState(JITTER, 3, 42);
    expect(second).toEqual(first);
  });
});

const WAVE: TextPhysicsConfig = {
  effect: "wave",
  grouping: "character",
  positionAmplitude: 2,
  periodFrames: 20,
  delayFrames: 5,
};

describe("resolveGlyphPhysicsState: wave", () => {
  it("oscillates sinusoidally, peaking at one quarter-period", () => {
    expect(resolveGlyphPhysicsState(WAVE, 0, 5).offsetY).toBeCloseTo(2, 5);
  });

  it("phase-shifts a later rank by rank * delayFrames", () => {
    const rank1AtFrame10 = resolveGlyphPhysicsState(WAVE, 1, 10);
    const rank0AtFrame5 = resolveGlyphPhysicsState(WAVE, 0, 5);
    expect(rank1AtFrame10.offsetY).toBeCloseTo(rank0AtFrame5.offsetY as number, 10);
  });

  it("never settles: oscillates indefinitely", () => {
    const farFuture = resolveGlyphPhysicsState(WAVE, 0, 5 + 20 * 1000);
    expect(farFuture.offsetY).toBeCloseTo(2, 5);
  });

  it("never sets opacity, scale, offsetX, or rotationZ", () => {
    const state = resolveGlyphPhysicsState(WAVE, 0, 5);
    expect(state.opacity).toBeUndefined();
    expect(state.scale).toBeUndefined();
    expect(state.offsetX).toBeUndefined();
    expect(state.rotationZ).toBeUndefined();
  });
});

describe("resolveGlyphPhysicsState: content effects resolve to no transform", () => {
  it("scramble resolves to an empty state", () => {
    const config: TextPhysicsConfig = { effect: "scramble", grouping: "character" };
    expect(resolveGlyphPhysicsState(config, 0, 10)).toEqual({});
  });

  it("countUp resolves to an empty state", () => {
    const config: TextPhysicsConfig = { effect: "countUp", grouping: "character", toValue: 100 };
    expect(resolveGlyphPhysicsState(config, 0, 10)).toEqual({});
  });
});
