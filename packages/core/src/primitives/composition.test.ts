import { describe, expect, it } from "vitest";

import { createComposition } from "./composition.js";

describe("createComposition", () => {
  it("defaults tracks to an empty array when omitted", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
    });

    expect(composition).toEqual({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      tracks: [],
    });
  });

  it("preserves tracks when provided", () => {
    const tracks = [{ id: "track-1", clips: [] }];

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 24,
      durationInFrames: 100,
      width: 1280,
      height: 720,
      tracks,
    });

    expect(composition.tracks).toEqual(tracks);
  });
});
