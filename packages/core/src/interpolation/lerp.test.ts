import { describe, expect, it } from "vitest";

import type { ColorRGBA, Vector2, Vector3 } from "../scene-graph/primitives.js";
import { interpolateColor, interpolateVector2, interpolateVector3, lerp } from "./lerp.js";

describe("lerp", () => {
  it("returns 'from' at t=0 and 'to' at t=1", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it("returns the midpoint at t=0.5", () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
  });

  it("handles a reversed (decreasing) from/to pair", () => {
    expect(lerp(100, 0, 0.25)).toBe(75);
  });
});

describe("interpolateColor", () => {
  const from: ColorRGBA = [0, 0, 0, 0];
  const to: ColorRGBA = [1, 1, 1, 1];

  it("returns the 'from' color at t=0", () => {
    expect(interpolateColor(0, from, to)).toEqual([0, 0, 0, 0]);
  });

  it("returns the 'to' color at t=1", () => {
    expect(interpolateColor(1, from, to)).toEqual([1, 1, 1, 1]);
  });

  it("returns the per-channel midpoint at t=0.5", () => {
    expect(interpolateColor(0.5, from, to)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("interpolates each channel independently", () => {
    const red: ColorRGBA = [1, 0, 0, 1];
    const blue: ColorRGBA = [0, 0, 1, 1];
    expect(interpolateColor(0.5, red, blue)).toEqual([0.5, 0, 0.5, 1]);
  });
});

describe("interpolateVector2", () => {
  const from: Vector2 = [0, 0];
  const to: Vector2 = [10, 20];

  it("returns 'from' at t=0 and 'to' at t=1", () => {
    expect(interpolateVector2(0, from, to)).toEqual([0, 0]);
    expect(interpolateVector2(1, from, to)).toEqual([10, 20]);
  });

  it("returns the per-component midpoint at t=0.5", () => {
    expect(interpolateVector2(0.5, from, to)).toEqual([5, 10]);
  });
});

describe("interpolateVector3", () => {
  const from: Vector3 = [0, 0, 0];
  const to: Vector3 = [10, 20, 30];

  it("returns 'from' at t=0 and 'to' at t=1", () => {
    expect(interpolateVector3(0, from, to)).toEqual([0, 0, 0]);
    expect(interpolateVector3(1, from, to)).toEqual([10, 20, 30]);
  });

  it("returns the per-component midpoint at t=0.5", () => {
    expect(interpolateVector3(0.5, from, to)).toEqual([5, 10, 15]);
  });
});
