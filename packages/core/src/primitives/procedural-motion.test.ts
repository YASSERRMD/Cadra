import { describe, expect, it } from "vitest";

import type { KeyframeTrack } from "../keyframes/keyframe-track.js";
import type { Vector3 } from "../scene-graph/primitives.js";
import {
  computeLookAtRotation,
  followPath,
  noiseMotion,
  orbit,
  secondarySpringMotion,
} from "./procedural-motion.js";

const FPS = 30;

describe("noiseMotion", () => {
  it("calling twice with the same inputs returns the exact same vector", () => {
    const config = { seed: "wander", center: [1, 2, 3] as Vector3, amplitude: [2, 2, 2] as Vector3 };
    const first = noiseMotion(config, 45, FPS);
    const second = noiseMotion(config, 45, FPS);
    expect(first).toEqual(second);
  });

  it("has no shared/leaked state: out-of-order evaluation matches direct evaluation", () => {
    const config = { seed: "wander", amplitude: [1, 1, 1] as Vector3 };
    const frame90First = noiseMotion(config, 90, FPS);
    const frame10 = noiseMotion(config, 10, FPS);
    const frame90Second = noiseMotion(config, 90, FPS);
    expect(frame90First).toEqual(frame90Second);
    expect(frame10).not.toEqual(frame90First);
  });

  it("stays within center +/- amplitude on every axis", () => {
    const center: Vector3 = [5, -3, 2];
    const amplitude: Vector3 = [1, 2, 0.5];
    for (let frame = 0; frame < 300; frame += 7) {
      const [x, y, z] = noiseMotion({ seed: 1, center, amplitude }, frame, FPS);
      expect(x).toBeGreaterThanOrEqual(center[0] - amplitude[0]);
      expect(x).toBeLessThanOrEqual(center[0] + amplitude[0]);
      expect(y).toBeGreaterThanOrEqual(center[1] - amplitude[1]);
      expect(y).toBeLessThanOrEqual(center[1] + amplitude[1]);
      expect(z).toBeGreaterThanOrEqual(center[2] - amplitude[2]);
      expect(z).toBeLessThanOrEqual(center[2] + amplitude[2]);
    }
  });

  it("wanders (is not constant across frames) for a non-zero amplitude", () => {
    const values = Array.from({ length: 20 }, (_, i) => noiseMotion({ seed: "s", amplitude: [1, 1, 1] }, i * 5, FPS));
    const distinct = new Set(values.map((v) => JSON.stringify(v)));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it("a different seed produces a different wander", () => {
    const a = noiseMotion({ seed: "a", amplitude: [1, 1, 1] }, 50, FPS);
    const b = noiseMotion({ seed: "b", amplitude: [1, 1, 1] }, 50, FPS);
    expect(a).not.toEqual(b);
  });

  it("defaults to center [0,0,0] and amplitude [1,1,1] when omitted", () => {
    const [x, y, z] = noiseMotion({}, 20, FPS);
    expect(x).toBeGreaterThanOrEqual(-1);
    expect(x).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(-1);
    expect(y).toBeLessThanOrEqual(1);
    expect(z).toBeGreaterThanOrEqual(-1);
    expect(z).toBeLessThanOrEqual(1);
  });
});

describe("orbit", () => {
  it("calling twice with the same inputs returns the exact same vector", () => {
    const config = { center: [1, 0, 0] as Vector3, radius: 2, axis: "y" as const };
    expect(orbit(config, 17, FPS)).toEqual(orbit(config, 17, FPS));
  });

  it("stays exactly radius away from center on every frame", () => {
    const center: Vector3 = [2, -1, 3];
    const radius = 4;
    for (const axis of ["x", "y", "z"] as const) {
      for (let frame = 0; frame < 90; frame += 11) {
        const [x, y, z] = orbit({ center, radius, axis }, frame, FPS);
        const distance = Math.hypot(x - center[0], y - center[1], z - center[2]);
        expect(distance).toBeCloseTo(radius, 9);
      }
    }
  });

  it("keeps the orbit axis's own coordinate fixed at center's value", () => {
    const center: Vector3 = [1, 2, 3];
    for (let frame = 0; frame < 60; frame += 13) {
      expect(orbit({ center, axis: "x" }, frame, FPS)[0]).toBeCloseTo(center[0], 9);
      expect(orbit({ center, axis: "y" }, frame, FPS)[1]).toBeCloseTo(center[1], 9);
      expect(orbit({ center, axis: "z" }, frame, FPS)[2]).toBeCloseTo(center[2], 9);
    }
  });

  it("frame 0 with phase 0 sits at angle 0 (center + radius along the plane's own first axis)", () => {
    const [x, y, z] = orbit({ center: [0, 0, 0], radius: 3, axis: "y" }, 0, FPS);
    expect(x).toBeCloseTo(3, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
  });

  it("phase offsets the starting angle", () => {
    const withoutPhase = orbit({ radius: 1, axis: "y" }, 0, FPS);
    const withPhase = orbit({ radius: 1, axis: "y", phase: Math.PI / 2 }, 0, FPS);
    expect(withPhase[0]).toBeCloseTo(0, 9);
    expect(withPhase[2]).toBeCloseTo(1, 9);
    expect(withoutPhase).not.toEqual(withPhase);
  });

  it("returns to its starting position after exactly one full revolution", () => {
    const config = { center: [1, 1, 1] as Vector3, radius: 2, axis: "z" as const, revolutionsPerSecond: 0.5 };
    const start = orbit(config, 0, FPS);
    const framesPerRevolution = FPS / 0.5;
    const afterOneRevolution = orbit(config, framesPerRevolution, FPS);
    expect(afterOneRevolution[0]).toBeCloseTo(start[0], 9);
    expect(afterOneRevolution[1]).toBeCloseTo(start[1], 9);
    expect(afterOneRevolution[2]).toBeCloseTo(start[2], 9);
  });

  it("a negative revolutionsPerSecond reverses direction", () => {
    const forward = orbit({ radius: 1, axis: "y", revolutionsPerSecond: 0.25 }, 5, FPS);
    const backward = orbit({ radius: 1, axis: "y", revolutionsPerSecond: -0.25 }, 5, FPS);
    expect(forward[2]).toBeCloseTo(-backward[2], 9);
  });
});

describe("followPath", () => {
  const straightPath = { start: [0, 0, 0] as Vector3, segments: [{ type: "line" as const, to: [10, 0, 0] as Vector3 }] };

  it("calling twice with the same inputs returns the exact same result", () => {
    const first = followPath(straightPath, 5, { durationInFrames: 30 });
    const second = followPath(straightPath, 5, { durationInFrames: 30 });
    expect(first).toEqual(second);
  });

  it("sits exactly at the path's own start at frame 0", () => {
    const result = followPath(straightPath, 0, { durationInFrames: 30 });
    expect(result.position).toEqual([0, 0, 0]);
  });

  it("reaches the path's own final point at durationInFrames, and holds there past it (loop: false, the default)", () => {
    const atEnd = followPath(straightPath, 30, { durationInFrames: 30 });
    expect(atEnd.position[0]).toBeCloseTo(10, 9);
    const pastEnd = followPath(straightPath, 45, { durationInFrames: 30 });
    expect(pastEnd.position[0]).toBeCloseTo(10, 9);
  });

  it("wraps back to the start once progress exceeds 1 when loop: true", () => {
    const halfway = followPath(straightPath, 15, { durationInFrames: 30, loop: true });
    const oneAndAHalf = followPath(straightPath, 45, { durationInFrames: 30, loop: true });
    expect(oneAndAHalf.position[0]).toBeCloseTo(halfway.position[0], 9);
  });

  it("moves at constant speed along a straight line with the default linear easing", () => {
    const quarter = followPath(straightPath, 7.5, { durationInFrames: 30 });
    expect(quarter.position[0]).toBeCloseTo(2.5, 9);
  });

  it("an easing curve still starts and ends at the path's own endpoints, only changing the pacing between them", () => {
    const start = followPath(straightPath, 0, { durationInFrames: 30, easing: "easeInOutCubic" });
    const end = followPath(straightPath, 30, { durationInFrames: 30, easing: "easeInOutCubic" });
    expect(start.position[0]).toBeCloseTo(0, 9);
    expect(end.position[0]).toBeCloseTo(10, 9);

    const linearQuarter = followPath(straightPath, 7.5, { durationInFrames: 30 }).position[0];
    const easedQuarter = followPath(straightPath, 7.5, { durationInFrames: 30, easing: "easeInOutCubic" }).position[0];
    expect(easedQuarter).not.toBeCloseTo(linearQuarter, 3);
  });

  it("reports a unit tangent pointing along the direction of travel", () => {
    const result = followPath(straightPath, 10, { durationInFrames: 30 });
    expect(result.tangent[0]).toBeCloseTo(1, 9);
    expect(result.tangent[1]).toBeCloseTo(0, 9);
    expect(result.tangent[2]).toBeCloseTo(0, 9);
  });

  it("re-resolves an animated control point fresh at each frame", () => {
    const movingPath = {
      start: [0, 0, 0] as Vector3,
      segments: [
        {
          type: "line" as const,
          to: {
            type: "keyframeTrack" as const,
            keyframes: [
              { frame: 0, value: [10, 0, 0] as Vector3 },
              { frame: 30, value: [0, 10, 0] as Vector3 },
            ],
          },
        },
      ],
    };
    // At frame 0 (u = 0/30 = 0), position is the path's own fixed start
    // point - u=0 never reaches the moving "to" endpoint at all, regardless
    // of what it resolves to.
    const atStart = followPath(movingPath, 0, { durationInFrames: 30 });
    expect(atStart.position).toEqual([0, 0, 0]);

    // At frame 30 (u = 30/30 = 1, the path's own end), position is exactly
    // the "to" keyframe's own value AT FRAME 30 - proving the control point
    // is resolved fresh from the frame given to this exact call, not baked
    // once from some other frame's value.
    const atEnd = followPath(movingPath, 30, { durationInFrames: 30 });
    expect(atEnd.position[0]).toBeCloseTo(0, 9);
    expect(atEnd.position[1]).toBeCloseTo(10, 9);
  });
});

describe("computeLookAtRotation", () => {
  // Every expected value below was cross-verified directly against a real
  // `THREE.PerspectiveCamera.lookAt(...)` (this codebase's own established
  // convention for eye/target/up, per that method's `isCamera` branch) in a
  // standalone script, not hand-derived - see this function's own doc for
  // why a camera (not a plain Object3D, whose `lookAt` swaps eye and target)
  // is the correct reference.
  it("looking straight down -Z at the default up needs no rotation", () => {
    const [x, y, z] = computeLookAtRotation([0, 0, 5], [0, 0, 0]);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it("looking along -X from +X matches the real THREE.Camera.lookAt reference exactly", () => {
    const [x, y, z] = computeLookAtRotation([5, 0, 0], [0, 0, 0]);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(1.5708, 4);
    expect(z).toBeCloseTo(0, 5);
  });

  it("an off-axis eye/target pair matches the real THREE.Camera.lookAt reference exactly", () => {
    const [x, y, z] = computeLookAtRotation([3, 2, 7], [-1, 4, 2]);
    expect(x).toBeCloseTo(0.38051, 4);
    expect(y).toBeCloseTo(0.63887, 4);
    expect(z).toBeCloseTo(-0.23414, 4);
  });

  it("does not throw and returns a well-defined rotation when eye equals target (nothing to face)", () => {
    expect(() => computeLookAtRotation([1, 1, 1], [1, 1, 1])).not.toThrow();
    const [x, y, z] = computeLookAtRotation([1, 1, 1], [1, 1, 1]);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
    expect(Number.isFinite(z)).toBe(true);
  });

  it("a custom up vector with a z-component of exactly 1 matches the real THREE.Camera.lookAt reference exactly (the one tie-break Matrix4.lookAt branches on)", () => {
    // Matrix4.lookAt's own degenerate-direction tie-break specifically
    // checks `up.z === 1`, not any component of the eye/target direction -
    // this is the one scenario that actually distinguishes that condition
    // from a plausible-looking but wrong alternative (a real, if narrow,
    // bug this exact test caught during development).
    const [x, y, z] = computeLookAtRotation([0, 0, 10], [0, 0, 0], [0, 0, 1]);
    expect(x).toBeCloseTo(0, 3);
    expect(y).toBeCloseTo(0.0001, 3);
    expect(z).toBeCloseTo(1.5708, 4);
  });

  it("does not throw when eye is directly above target (up parallel to the look direction)", () => {
    const [x, y, z] = computeLookAtRotation([0, 10, 0], [0, 0, 0]);
    expect(x).toBeCloseTo(-1.5707, 3);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it("calling twice with the same inputs returns the exact same rotation", () => {
    const first = computeLookAtRotation([3, 2, 7], [-1, 4, 2]);
    const second = computeLookAtRotation([3, 2, 7], [-1, 4, 2]);
    expect(first).toEqual(second);
  });
});

describe("secondarySpringMotion", () => {
  it("returns the primary's own frame-0 value at frame 0", () => {
    const primary: Vector3 = [3, -2, 5];
    expect(secondarySpringMotion(primary, {}, 0, FPS)).toEqual(primary);
  });

  it("calling twice with the same inputs returns the exact same vector", () => {
    const primary: Vector3 = [1, 2, 3];
    const config = { mass: 1, stiffness: 120, damping: 14 };
    expect(secondarySpringMotion(primary, config, 20, FPS)).toEqual(secondarySpringMotion(primary, config, 20, FPS));
  });

  it("a constant primary never moves: starting at rest exactly at a stationary target applies no restoring force", () => {
    // A plain (non-keyframed) Property<Vector3> resolves to itself at every
    // frame, including frame 0 - secondarySpringMotion always starts at rest
    // at the primary's own frame-0 value, so a constant primary and a
    // starting position are the exact same point with zero velocity: there
    // is nothing for the spring to settle from, at any frame.
    const primary: Vector3 = [10, -3, 2];
    const result = secondarySpringMotion(primary, { stiffness: 150, damping: 15 }, 90, FPS);
    expect(result).toEqual(primary);
  });

  it("has no shared/leaked state: out-of-order evaluation matches direct evaluation", () => {
    const primary: KeyframeTrack<Vector3> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0], easing: "hold" },
        { frame: 15, value: [0, 5, 0] },
      ],
    };
    const config = { stiffness: 150, damping: 15 };
    const frame60First = secondarySpringMotion(primary, config, 60, FPS);
    const frame5 = secondarySpringMotion(primary, config, 5, FPS);
    const frame60Second = secondarySpringMotion(primary, config, 60, FPS);
    expect(frame60First).toEqual(frame60Second);
    expect(frame5).not.toEqual(frame60First);
  });

  it("chases a primary that jumps partway through, lagging behind rather than teleporting", () => {
    const primary: KeyframeTrack<Vector3> = {
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0], easing: "hold" },
        { frame: 30, value: [20, 0, 0] },
      ],
    };
    const config = { stiffness: 200, damping: 25 };

    // Just after the jump, the secondary hasn't caught up to the primary's
    // new value yet (it lags behind, unlike the primary itself which jumps
    // instantly at frame 30 courtesy of 'hold').
    const justAfterJump = secondarySpringMotion(primary, config, 31, FPS);
    expect(justAfterJump[0]).toBeGreaterThan(0);
    expect(justAfterJump[0]).toBeLessThan(20);

    // Given enough time after the jump, it settles close to the new value.
    const longAfterJump = secondarySpringMotion(primary, config, 30 + FPS * 3, FPS);
    expect(longAfterJump[0]).toBeCloseTo(20, 0);
  });
});
