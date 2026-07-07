import { describe, expect, it } from "vitest";

import { ClipNotFoundError, moveClipToTrack, updateClipTiming } from "./clip-operations.js";
import { createIdentityTransform } from "./primitives.js";
import type { SceneNode } from "./scene-node.js";
import type { Clip, Composition, Track } from "./timeline.js";

function makeNode(id: string): SceneNode {
  return { id, kind: "group", transform: createIdentityTransform(), visible: true, children: [] };
}

function makeClip(id: string, startFrame: number, durationInFrames: number): Clip {
  return { id, startFrame, durationInFrames, node: makeNode(`${id}-node`) };
}

function makeTrack(id: string, clips: Clip[]): Track {
  return { id, clips };
}

/** A composition with two tracks: track-a has two clips, track-b has one. */
function makeComposition(): Composition {
  return {
    id: "comp-1",
    name: "Comp",
    fps: 30,
    durationInFrames: 300,
    width: 1920,
    height: 1080,
    tracks: [
      makeTrack("track-a", [makeClip("clip-a1", 0, 30), makeClip("clip-a2", 30, 60)]),
      makeTrack("track-b", [makeClip("clip-b1", 0, 90)]),
    ],
  };
}

describe("updateClipTiming", () => {
  it("updates startFrame only, leaving durationInFrames unchanged", () => {
    const composition = makeComposition();

    const result = updateClipTiming(composition, "track-a", "clip-a1", { startFrame: 10 });

    const clip = result.tracks[0]?.clips[0];
    expect(clip?.startFrame).toBe(10);
    expect(clip?.durationInFrames).toBe(30);
  });

  it("updates durationInFrames only, leaving startFrame unchanged", () => {
    const composition = makeComposition();

    const result = updateClipTiming(composition, "track-a", "clip-a1", { durationInFrames: 45 });

    const clip = result.tracks[0]?.clips[0];
    expect(clip?.startFrame).toBe(0);
    expect(clip?.durationInFrames).toBe(45);
  });

  it("updates both startFrame and durationInFrames together", () => {
    const composition = makeComposition();

    const result = updateClipTiming(composition, "track-a", "clip-a2", {
      startFrame: 50,
      durationInFrames: 20,
    });

    const clip = result.tracks[0]?.clips[1];
    expect(clip?.startFrame).toBe(50);
    expect(clip?.durationInFrames).toBe(20);
  });

  it("does not mutate the original composition", () => {
    const composition = makeComposition();
    const before = structuredClone(composition);

    updateClipTiming(composition, "track-a", "clip-a1", { startFrame: 99 });

    expect(composition).toEqual(before);
  });

  it("keeps unaffected tracks reference-identical (structural sharing)", () => {
    const composition = makeComposition();
    const trackB = composition.tracks[1];

    const result = updateClipTiming(composition, "track-a", "clip-a1", { startFrame: 5 });

    expect(result.tracks[1]).toBe(trackB);
  });

  it("keeps unaffected clips on the same track reference-identical", () => {
    const composition = makeComposition();
    const clipA2 = composition.tracks[0]?.clips[1];

    const result = updateClipTiming(composition, "track-a", "clip-a1", { startFrame: 5 });

    expect(result.tracks[0]?.clips[1]).toBe(clipA2);
  });

  it("preserves the clip's node reference (does not touch scene-node content)", () => {
    const composition = makeComposition();
    const originalNode = composition.tracks[0]?.clips[0]?.node;

    const result = updateClipTiming(composition, "track-a", "clip-a1", { startFrame: 5 });

    expect(result.tracks[0]?.clips[0]?.node).toBe(originalNode);
  });

  it("creates new objects along the composition -> tracks -> track -> clips -> clip path", () => {
    const composition = makeComposition();

    const result = updateClipTiming(composition, "track-a", "clip-a1", { startFrame: 5 });

    expect(result).not.toBe(composition);
    expect(result.tracks).not.toBe(composition.tracks);
    expect(result.tracks[0]).not.toBe(composition.tracks[0]);
    expect(result.tracks[0]?.clips).not.toBe(composition.tracks[0]?.clips);
    expect(result.tracks[0]?.clips[0]).not.toBe(composition.tracks[0]?.clips[0]);
  });

  it("throws ClipNotFoundError for an unknown trackId", () => {
    const composition = makeComposition();
    expect(() =>
      updateClipTiming(composition, "does-not-exist", "clip-a1", { startFrame: 1 }),
    ).toThrow(ClipNotFoundError);
  });

  it("throws ClipNotFoundError for an unknown clipId on a known track", () => {
    const composition = makeComposition();
    expect(() =>
      updateClipTiming(composition, "track-a", "does-not-exist", { startFrame: 1 }),
    ).toThrow(ClipNotFoundError);
  });

  it("an empty update object leaves the clip unchanged", () => {
    const composition = makeComposition();

    const result = updateClipTiming(composition, "track-a", "clip-a1", {});

    expect(result.tracks[0]?.clips[0]).toEqual(composition.tracks[0]?.clips[0]);
  });
});

describe("moveClipToTrack", () => {
  it("moves a clip from its source track to a different target track", () => {
    const composition = makeComposition();

    const result = moveClipToTrack(composition, "track-a", "clip-a1", "track-b");

    expect(result.tracks[0]?.clips.map((c) => c.id)).toEqual(["clip-a2"]);
    expect(result.tracks[1]?.clips.map((c) => c.id)).toEqual(["clip-b1", "clip-a1"]);
  });

  it("applies a timing update to the moved clip", () => {
    const composition = makeComposition();

    const result = moveClipToTrack(composition, "track-a", "clip-a1", "track-b", {
      startFrame: 90,
    });

    const moved = result.tracks[1]?.clips.find((c) => c.id === "clip-a1");
    expect(moved?.startFrame).toBe(90);
  });

  it("reorders a clip within the same track (moves it to the end of the array)", () => {
    const composition = makeComposition();

    const result = moveClipToTrack(composition, "track-a", "clip-a1", "track-a");

    expect(result.tracks[0]?.clips.map((c) => c.id)).toEqual(["clip-a2", "clip-a1"]);
  });

  it("reordering within the same track can combine with a timing update", () => {
    const composition = makeComposition();

    const result = moveClipToTrack(composition, "track-a", "clip-a1", "track-a", {
      startFrame: 200,
    });

    const reordered = result.tracks[0]?.clips.find((c) => c.id === "clip-a1");
    expect(reordered?.startFrame).toBe(200);
    expect(result.tracks[0]?.clips.map((c) => c.id)).toEqual(["clip-a2", "clip-a1"]);
  });

  it("does not mutate the original composition", () => {
    const composition = makeComposition();
    const before = structuredClone(composition);

    moveClipToTrack(composition, "track-a", "clip-a1", "track-b");

    expect(composition).toEqual(before);
  });

  it("keeps a wholly unaffected track reference-identical when moving between two other tracks", () => {
    const composition: Composition = {
      ...makeComposition(),
      tracks: [
        ...makeComposition().tracks,
        makeTrack("track-c", [makeClip("clip-c1", 0, 10)]),
      ],
    };
    const trackC = composition.tracks[2];

    const result = moveClipToTrack(composition, "track-a", "clip-a1", "track-b");

    expect(result.tracks[2]).toBe(trackC);
  });

  it("preserves the moved clip's node reference", () => {
    const composition = makeComposition();
    const originalNode = composition.tracks[0]?.clips[0]?.node;

    const result = moveClipToTrack(composition, "track-a", "clip-a1", "track-b");

    const moved = result.tracks[1]?.clips.find((c) => c.id === "clip-a1");
    expect(moved?.node).toBe(originalNode);
  });

  it("throws ClipNotFoundError for an unknown sourceTrackId", () => {
    const composition = makeComposition();
    expect(() => moveClipToTrack(composition, "does-not-exist", "clip-a1", "track-b")).toThrow(
      ClipNotFoundError,
    );
  });

  it("throws ClipNotFoundError for an unknown clipId on the source track", () => {
    const composition = makeComposition();
    expect(() =>
      moveClipToTrack(composition, "track-a", "does-not-exist", "track-b"),
    ).toThrow(ClipNotFoundError);
  });

  it("throws ClipNotFoundError for an unknown targetTrackId", () => {
    const composition = makeComposition();
    expect(() =>
      moveClipToTrack(composition, "track-a", "clip-a1", "does-not-exist"),
    ).toThrow(ClipNotFoundError);
  });
});
