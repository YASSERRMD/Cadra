import { describe, expect, it } from "vitest";

import { Series } from "./series.js";
import { Shape } from "./shape.js";

describe("Series", () => {
  it("starts the first entry at frame 0", () => {
    const clips = Series([{ id: "clip-1", durationInFrames: 10, content: Shape({ id: "s1" }) }]);

    expect(clips[0]?.startFrame).toBe(0);
  });

  it("computes cumulative start frames for three entries of durations 10, 20, 15", () => {
    const clips = Series([
      { id: "clip-1", durationInFrames: 10, content: Shape({ id: "s1" }) },
      { id: "clip-2", durationInFrames: 20, content: Shape({ id: "s2" }) },
      { id: "clip-3", durationInFrames: 15, content: Shape({ id: "s3" }) },
    ]);

    expect(clips.map((clip) => clip.startFrame)).toEqual([0, 10, 30]);
    expect(clips.map((clip) => clip.durationInFrames)).toEqual([10, 20, 15]);
  });

  it("returns a Clip array, one per entry, each carrying its own id and content", () => {
    const contentA = Shape({ id: "shape-a" });
    const contentB = Shape({ id: "shape-b" });

    const clips = Series([
      { id: "clip-a", durationInFrames: 5, content: contentA },
      { id: "clip-b", durationInFrames: 7, content: contentB },
    ]);

    expect(clips).toHaveLength(2);
    expect(clips[0]).toEqual({
      id: "clip-a",
      startFrame: 0,
      durationInFrames: 5,
      node: contentA,
    });
    expect(clips[1]).toEqual({
      id: "clip-b",
      startFrame: 5,
      durationInFrames: 7,
      node: contentB,
    });
  });

  it("returns an empty array for an empty entry list", () => {
    expect(Series([])).toEqual([]);
  });
});
