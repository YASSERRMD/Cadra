import type { ParticleColorStop } from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PARTICLE_COLOR,
  DEFAULT_PARTICLE_SIZE_MULTIPLIER,
  resolveColorOverLife,
  resolveSizeOverLife,
} from "./color-size-curves.js";

describe("resolveColorOverLife", () => {
  it("returns the default opaque white when stops is undefined", () => {
    expect(resolveColorOverLife(undefined, 0.5)).toEqual(DEFAULT_PARTICLE_COLOR);
  });

  it("returns the default opaque white when stops is empty", () => {
    expect(resolveColorOverLife([], 0.5)).toEqual(DEFAULT_PARTICLE_COLOR);
  });

  it("returns the single stop's color for the whole lifetime when only one stop is given", () => {
    const stops: ParticleColorStop[] = [{ time: 0.3, color: [0.2, 0.4, 0.6, 1] }];
    expect(resolveColorOverLife(stops, 0)).toEqual([0.2, 0.4, 0.6, 1]);
    expect(resolveColorOverLife(stops, 1)).toEqual([0.2, 0.4, 0.6, 1]);
  });

  it("returns each stop's own color exactly at its own time", () => {
    const stops: ParticleColorStop[] = [
      { time: 0, color: [1, 0, 0, 1] },
      { time: 1, color: [0, 0, 1, 1] },
    ];
    expect(resolveColorOverLife(stops, 0)).toEqual([1, 0, 0, 1]);
    expect(resolveColorOverLife(stops, 1)).toEqual([0, 0, 1, 1]);
  });

  it("linearly interpolates between two stops", () => {
    const stops: ParticleColorStop[] = [
      { time: 0, color: [0, 0, 0, 0] },
      { time: 1, color: [1, 1, 1, 1] },
    ];
    expect(resolveColorOverLife(stops, 0.5)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("clamps t before the first stop to the first stop's color", () => {
    const stops: ParticleColorStop[] = [
      { time: 0.2, color: [1, 0, 0, 1] },
      { time: 0.8, color: [0, 1, 0, 1] },
    ];
    expect(resolveColorOverLife(stops, 0)).toEqual([1, 0, 0, 1]);
  });

  it("clamps t after the last stop to the last stop's color", () => {
    const stops: ParticleColorStop[] = [
      { time: 0.2, color: [1, 0, 0, 1] },
      { time: 0.8, color: [0, 1, 0, 1] },
    ];
    expect(resolveColorOverLife(stops, 1)).toEqual([0, 1, 0, 1]);
  });

  it("interpolates within the correct bracket among three or more stops", () => {
    const stops: ParticleColorStop[] = [
      { time: 0, color: [1, 1, 1, 1] },
      { time: 0.5, color: [1, 0, 0, 1] },
      { time: 1, color: [0, 0, 0, 0] },
    ];
    expect(resolveColorOverLife(stops, 0.25)).toEqual([1, 0.5, 0.5, 1]);
    expect(resolveColorOverLife(stops, 0.75)).toEqual([0.5, 0, 0, 0.5]);
  });

  it("does not require stops to already be sorted by time", () => {
    const stops: ParticleColorStop[] = [
      { time: 1, color: [0, 0, 0, 0] },
      { time: 0, color: [1, 1, 1, 1] },
    ];
    expect(resolveColorOverLife(stops, 0.5)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe("resolveSizeOverLife", () => {
  it("returns the default constant 1 when stops is undefined", () => {
    expect(resolveSizeOverLife(undefined, 0.5)).toBe(DEFAULT_PARTICLE_SIZE_MULTIPLIER);
  });

  it("returns the default constant 1 when stops is empty", () => {
    expect(resolveSizeOverLife([], 0.5)).toBe(DEFAULT_PARTICLE_SIZE_MULTIPLIER);
  });

  it("linearly interpolates between two stops", () => {
    const stops = [
      { time: 0, size: 0 },
      { time: 1, size: 2 },
    ];
    expect(resolveSizeOverLife(stops, 0.5)).toBeCloseTo(1, 10);
  });

  it("clamps outside the outermost stops", () => {
    const stops = [
      { time: 0.2, size: 0.5 },
      { time: 0.8, size: 1.5 },
    ];
    expect(resolveSizeOverLife(stops, 0)).toBe(0.5);
    expect(resolveSizeOverLife(stops, 1)).toBe(1.5);
  });

  it("a common bell-curve shape (small, big, small) resolves the middle stop at its own time", () => {
    const stops = [
      { time: 0, size: 0 },
      { time: 0.5, size: 1 },
      { time: 1, size: 0 },
    ];
    expect(resolveSizeOverLife(stops, 0.5)).toBe(1);
    expect(resolveSizeOverLife(stops, 0)).toBe(0);
    expect(resolveSizeOverLife(stops, 1)).toBe(0);
  });
});
