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

  it("omits activeCameraTrack and audioTracks entirely when not provided", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
    });

    expect("activeCameraTrack" in composition).toBe(false);
    expect("audioTracks" in composition).toBe(false);
  });

  it("preserves activeCameraTrack when provided", () => {
    const activeCameraTrack = [{ startFrame: 0, durationInFrames: 30, cameraNodeId: "cam-1" }];

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      activeCameraTrack,
    });

    expect(composition.activeCameraTrack).toEqual(activeCameraTrack);
  });

  it("preserves audioTracks when provided", () => {
    const audioTracks = [{ id: "audio-1", clips: [] }];

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      audioTracks,
    });

    expect(composition.audioTracks).toEqual(audioTracks);
  });
});
