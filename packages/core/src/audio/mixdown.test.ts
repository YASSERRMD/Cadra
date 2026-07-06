import { describe, expect, it } from "vitest";

import { createComposition } from "../primitives/composition.js";
import type { AudioTrack, Project } from "../scene-graph/timeline.js";
import { CompositionNotFoundError } from "../timeline-engine/errors.js";
import { resolveAudioMixdown } from "./mixdown.js";

function buildProject(audioTracks: AudioTrack[] | undefined): Project {
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: 30,
    durationInFrames: 90,
    width: 640,
    height: 360,
  });
  return {
    id: "p1",
    name: "Project",
    compositions: [{ ...composition, ...(audioTracks !== undefined && { audioTracks }) }],
  };
}

describe("resolveAudioMixdown: composition with no audioTracks", () => {
  it("resolves to an empty segments array", () => {
    const project = buildProject(undefined);
    const mixdown = resolveAudioMixdown(project, "comp-1");
    expect(mixdown).toEqual({ compositionId: "comp-1", segments: [] });
  });

  it("resolves to an empty segments array for an explicitly empty audioTracks list", () => {
    const project = buildProject([]);
    expect(resolveAudioMixdown(project, "comp-1").segments).toEqual([]);
  });
});

describe("resolveAudioMixdown: flattening multiple tracks and clips", () => {
  it("flattens every clip across every track, in track/clip order, with defaults applied", () => {
    const project = buildProject([
      {
        id: "track-a",
        clips: [
          { id: "clip-a1", startFrame: 0, durationInFrames: 30, assetRef: "music.mp3" },
          { id: "clip-a2", startFrame: 30, durationInFrames: 30, assetRef: "music-2.mp3" },
        ],
      },
      {
        id: "track-b",
        clips: [
          {
            id: "clip-b1",
            startFrame: 10,
            durationInFrames: 20,
            assetRef: "sfx.wav",
            trimStartFrames: 5,
            gain: 0.5,
            fadeIn: { durationInFrames: 3 },
            fadeOut: { durationInFrames: 4 },
          },
        ],
      },
    ]);

    const mixdown = resolveAudioMixdown(project, "comp-1");

    expect(mixdown.compositionId).toBe("comp-1");
    expect(mixdown.segments).toEqual([
      {
        trackId: "track-a",
        clipId: "clip-a1",
        assetRef: "music.mp3",
        startFrame: 0,
        durationInFrames: 30,
        trimStartFrames: 0,
        gain: 1,
      },
      {
        trackId: "track-a",
        clipId: "clip-a2",
        assetRef: "music-2.mp3",
        startFrame: 30,
        durationInFrames: 30,
        trimStartFrames: 0,
        gain: 1,
      },
      {
        trackId: "track-b",
        clipId: "clip-b1",
        assetRef: "sfx.wav",
        startFrame: 10,
        durationInFrames: 20,
        trimStartFrames: 5,
        gain: 0.5,
        fadeIn: { durationInFrames: 3 },
        fadeOut: { durationInFrames: 4 },
      },
    ]);
  });

  it("omits fadeIn/fadeOut keys entirely from a segment when the clip has neither", () => {
    const project = buildProject([
      {
        id: "track-a",
        clips: [{ id: "clip-a1", startFrame: 0, durationInFrames: 30, assetRef: "music.mp3" }],
      },
    ]);

    const [segment] = resolveAudioMixdown(project, "comp-1").segments;
    expect(segment).toBeDefined();
    expect(segment).not.toHaveProperty("fadeIn");
    expect(segment).not.toHaveProperty("fadeOut");
  });
});

describe("resolveAudioMixdown: purity, independent of any real-time or preview state", () => {
  it("calling it twice for the same (project, compositionId) is deep-equal", () => {
    const project = buildProject([
      {
        id: "track-a",
        clips: [{ id: "clip-a1", startFrame: 0, durationInFrames: 30, assetRef: "music.mp3" }],
      },
    ]);

    const first = resolveAudioMixdown(project, "comp-1");
    const second = resolveAudioMixdown(project, "comp-1");

    expect(first).toEqual(second);
  });

  it("repeated calls remain deep-equal no matter how many times it has already been called", () => {
    const project = buildProject([
      {
        id: "track-a",
        clips: [
          { id: "clip-a1", startFrame: 0, durationInFrames: 30, assetRef: "music.mp3" },
          { id: "clip-a2", startFrame: 40, durationInFrames: 20, assetRef: "sfx.wav", gain: 0.2 },
        ],
      },
    ]);

    const results = Array.from({ length: 5 }, () => resolveAudioMixdown(project, "comp-1"));
    for (const result of results) {
      expect(result).toEqual(results[0]);
    }
  });

  it("does not take (or depend on) a frame argument: the same call resolves the whole timeline at once", () => {
    // resolveAudioMixdown's signature itself has no frame parameter; this
    // documents that guarantee with a runtime check that arity is exactly 2.
    expect(resolveAudioMixdown.length).toBe(2);
  });

  it("two distinct calls with different Project object references but identical audio data still deep-equal each other", () => {
    const projectA = buildProject([
      {
        id: "track-a",
        clips: [{ id: "clip-a1", startFrame: 0, durationInFrames: 30, assetRef: "music.mp3" }],
      },
    ]);
    const projectB = buildProject([
      {
        id: "track-a",
        clips: [{ id: "clip-a1", startFrame: 0, durationInFrames: 30, assetRef: "music.mp3" }],
      },
    ]);

    expect(resolveAudioMixdown(projectA, "comp-1")).toEqual(resolveAudioMixdown(projectB, "comp-1"));
  });
});

describe("resolveAudioMixdown: unknown composition", () => {
  it("throws CompositionNotFoundError", () => {
    const project = buildProject(undefined);
    expect(() => resolveAudioMixdown(project, "does-not-exist")).toThrow(CompositionNotFoundError);
  });
});
