import { describe, expect, it } from "vitest";

import { resolveBidi } from "./bidi-resolution.js";
import { combineSpans, splitRunsByStyle } from "./inline-style-runs.js";
import { computeItemizedRuns } from "./script-runs.js";

describe("combineSpans", () => {
  it("concatenates every span's text and maps each character back to its own span index", () => {
    const combined = combineSpans([{ text: "Hi " }, { text: "there" }, { text: "!" }]);

    expect(combined.text).toBe("Hi there!");
    expect(combined.styleIndexForChar).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 2]);
  });

  it("returns empty text and an empty map for no spans", () => {
    expect(combineSpans([])).toEqual({ text: "", styleIndexForChar: [] });
  });

  it("handles a span with empty text contributing no characters", () => {
    const combined = combineSpans([{ text: "AB" }, { text: "" }, { text: "CD" }]);
    expect(combined.text).toBe("ABCD");
    expect(combined.styleIndexForChar).toEqual([0, 0, 2, 2]);
  });
});

describe("splitRunsByStyle", () => {
  it("splits a single script/level run at a style boundary crossing it", () => {
    // "Hello World" is one Latin ltr run per computeItemizedRuns (a space
    // absorbs into the surrounding script, same as any other script-less
    // character), but two spans split at the word boundary here, so the
    // one script run must become two styled runs.
    const text = "Hello World";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);
    expect(runs).toHaveLength(1);

    const styleIndexForChar = [
      ...Array(6).fill(0), // "Hello "
      ...Array(5).fill(1), // "World"
    ];
    const styledRuns = splitRunsByStyle(runs, styleIndexForChar);

    expect(styledRuns).toEqual([
      { start: 0, end: 6, level: 0, direction: "ltr", script: "Latin", styleIndex: 0 },
      { start: 6, end: 11, level: 0, direction: "ltr", script: "Latin", styleIndex: 1 },
    ]);
  });

  it("leaves a run untouched (as one styled run) when it does not cross any style boundary", () => {
    const text = "Hello World";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);
    const styleIndexForChar = new Array(text.length).fill(0);

    const styledRuns = splitRunsByStyle(runs, styleIndexForChar);
    expect(styledRuns).toEqual([{ start: 0, end: 11, level: 0, direction: "ltr", script: "Latin", styleIndex: 0 }]);
  });

  it("further splits a run that crosses two style boundaries into three styled runs", () => {
    const text = "one two three";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);
    expect(runs).toHaveLength(1);

    const styleIndexForChar = [
      ...Array(4).fill(0), // "one "
      ...Array(4).fill(1), // "two "
      ...Array(5).fill(2), // "three"
    ];
    const styledRuns = splitRunsByStyle(runs, styleIndexForChar);

    expect(styledRuns.map((r) => [r.start, r.end, r.styleIndex])).toEqual([
      [0, 4, 0],
      [4, 8, 1],
      [8, 13, 2],
    ]);
  });

  it("still splits by both script and style when a run crosses a script boundary that does not align with style boundaries", () => {
    // "AB مرحبا CD": three script/level runs from computeItemizedRuns. One
    // style span spans across the first two scripts' boundary ("AB مر" all
    // styleIndex 0), proving splitRunsByStyle further divides *within* an
    // existing script run rather than only ever aligning with one.
    const text = "AB مرحبا CD";
    const runs = computeItemizedRuns(text, resolveBidi(text).levels);
    expect(runs.map((r) => [r.start, r.end])).toEqual([
      [0, 3],
      [3, 8],
      [8, 11],
    ]);

    const styleBoundary = 5; // splits the Arabic run (3,8) into (3,5) and (5,8)
    const styleIndexForChar = Array.from({ length: text.length }, (_, i) => (i < styleBoundary ? 0 : 1));
    const styledRuns = splitRunsByStyle(runs, styleIndexForChar);

    expect(styledRuns.map((r) => [r.start, r.end, r.script, r.styleIndex])).toEqual([
      [0, 3, "Latin", 0],
      [3, 5, "Arabic", 0],
      [5, 8, "Arabic", 1],
      [8, 11, "Latin", 1],
    ]);
  });

  it("returns no runs for no input runs", () => {
    expect(splitRunsByStyle([], [])).toEqual([]);
  });
});
