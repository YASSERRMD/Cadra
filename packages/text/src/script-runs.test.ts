import { describe, expect, it } from "vitest";

import { resolveBidi } from "./bidi-resolution.js";
import { computeItemizedRuns } from "./script-runs.js";

describe("computeItemizedRuns", () => {
  it("returns no runs for empty text", () => {
    expect(computeItemizedRuns("", new Uint8Array(0))).toEqual([]);
  });

  it("returns a single run for pure Latin text", () => {
    const text = "Hello";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);

    expect(runs).toEqual([{ start: 0, end: 5, level: 0, direction: "ltr", script: "Latin" }]);
  });

  it("returns a single run for pure Arabic text", () => {
    const text = "مرحبا";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);

    expect(runs).toEqual([{ start: 0, end: 5, level: 1, direction: "rtl", script: "Arabic" }]);
  });

  it("splits mixed Latin/Arabic text into per-script, per-direction runs in logical order", () => {
    const text = "AB مرحبا CD";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);

    expect(runs).toEqual([
      { start: 0, end: 3, level: 0, direction: "ltr", script: "Latin" },
      { start: 3, end: 8, level: 1, direction: "rtl", script: "Arabic" },
      { start: 8, end: 11, level: 0, direction: "ltr", script: "Latin" },
    ]);
  });

  it("absorbs trailing punctuation into the preceding run's script", () => {
    const text = "Hello.";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);

    expect(runs).toEqual([{ start: 0, end: 6, level: 0, direction: "ltr", script: "Latin" }]);
  });

  it("absorbs leading whitespace into the following run's script when there is no preceding one", () => {
    const text = " Hello";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);

    expect(runs).toEqual([{ start: 0, end: 6, level: 0, direction: "ltr", script: "Latin" }]);
  });

  it("keeps a run of pure whitespace as its own run when it is the entire text", () => {
    const text = "   ";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.start).toBe(0);
    expect(runs[0]?.end).toBe(3);
  });

  it("is deterministic across repeated calls", () => {
    const text = "AB مرحبا CD";
    const levels = resolveBidi(text).levels;

    expect(computeItemizedRuns(text, levels)).toEqual(computeItemizedRuns(text, levels));
  });
});
