import { createIdentityTransform, type SceneNode, Sequence } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";
import { describe, expect, it } from "vitest";

import { CompositionBuilder } from "./composition-builder.js";
import { SceneBuilderUsageError } from "./errors.js";
import { NodeBuilder } from "./node-builder.js";

function groupNode(id: string): SceneNode {
  return { id, kind: "group", transform: createIdentityTransform(), visible: true, children: [] };
}

const noopBuild = (): SceneDocument => {
  throw new Error("not used in these tests");
};

describe("CompositionBuilder: size resolution", () => {
  it("accepts a grouped size: { width, height }", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, size: { width: 640, height: 360 } },
      noopBuild,
    );
    expect(builder.toComposition().width).toBe(640);
    expect(builder.toComposition().height).toBe(360);
  });

  it("accepts flat width/height", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 800, height: 600 },
      noopBuild,
    );
    expect(builder.toComposition().width).toBe(800);
    expect(builder.toComposition().height).toBe(600);
  });
});

describe("CompositionBuilder.add", () => {
  it("places a NodeBuilder.at() placement onto the default track", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    builder.add(new NodeBuilder(groupNode("n1")).at(0, 10));

    const composition = builder.toComposition();
    expect(composition.tracks).toHaveLength(1);
    expect(composition.tracks[0]?.id).toBe("track-1");
    expect(composition.tracks[0]?.clips).toHaveLength(1);
  });

  it("accepts a bare Clip directly (e.g. from Sequence), not just a NodeBuilder placement", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    const clip = Sequence({ id: "seq-1", from: 0, durationInFrames: 15, content: groupNode("n1") });
    builder.add(clip);

    const composition = builder.toComposition();
    expect(composition.tracks[0]?.clips[0]).toEqual(clip);
  });

  it("places multiple .add() calls with an explicit trackId onto separate tracks", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    builder.add(new NodeBuilder(groupNode("a")).at(0, 10), "track-a");
    builder.add(new NodeBuilder(groupNode("b")).at(0, 10), "track-b");

    const composition = builder.toComposition();
    expect(composition.tracks.map((track) => track.id).sort()).toEqual(["track-a", "track-b"]);
  });

  it("appends multiple .add() calls with the same trackId onto the same track, in order", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    builder.add(new NodeBuilder(groupNode("first")).at(0, 10), "shared");
    builder.add(new NodeBuilder(groupNode("second")).at(10, 10), "shared");

    const composition = builder.toComposition();
    expect(composition.tracks).toHaveLength(1);
    expect(composition.tracks[0]?.clips.map((clip) => clip.node.id)).toEqual(["first", "second"]);
  });
});

describe("CompositionBuilder.addAll", () => {
  it("adds every clip in order to the same track", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 60, width: 640, height: 360 },
      noopBuild,
    );
    const clips = [
      Sequence({ id: "s1", from: 0, durationInFrames: 10, content: groupNode("n1") }),
      Sequence({ id: "s2", from: 10, durationInFrames: 10, content: groupNode("n2") }),
    ];
    builder.addAll(clips);

    const composition = builder.toComposition();
    expect(composition.tracks[0]?.clips.map((clip) => clip.id)).toEqual(["s1", "s2"]);
  });
});

describe("CompositionBuilder.track", () => {
  it("creates a named track that .add() can then target", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    builder.track("titles", "Titles Track");
    builder.add(new NodeBuilder(groupNode("n1")).at(0, 10), "titles");

    const composition = builder.toComposition();
    expect(composition.tracks).toHaveLength(1);
    expect(composition.tracks[0]?.name).toBe("Titles Track");
  });

  it("is idempotent: calling .track() again for the same id does not create a second track", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    builder.track("titles").track("titles");
    builder.add(new NodeBuilder(groupNode("n1")).at(0, 10), "titles");

    expect(builder.toComposition().tracks).toHaveLength(1);
  });
});

describe("CompositionBuilder: active camera track and audio tracks", () => {
  it("omits activeCameraTrack/audioTracks entirely when never set", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    const composition = builder.toComposition();
    expect("activeCameraTrack" in composition).toBe(false);
    expect("audioTracks" in composition).toBe(false);
  });

  it("sets activeCameraTrack when provided", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    builder.setActiveCameraTrack([{ startFrame: 0, durationInFrames: 30, cameraNodeId: "cam-1" }]);
    expect(builder.toComposition().activeCameraTrack).toEqual([
      { startFrame: 0, durationInFrames: 30, cameraNodeId: "cam-1" },
    ]);
  });

  it("sets audioTracks when provided", () => {
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      noopBuild,
    );
    builder.setAudioTracks([{ id: "audio-1", clips: [] }]);
    expect(builder.toComposition().audioTracks).toEqual([{ id: "audio-1", clips: [] }]);
  });
});

describe("CompositionBuilder.build", () => {
  it("delegates to the onBuild callback passed at construction", () => {
    const document: SceneDocument = {
      schemaVersion: 1,
      project: { id: "p", name: "P", compositions: [] },
    };
    const builder = new CompositionBuilder(
      { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640, height: 360 },
      () => document,
    );
    expect(builder.build()).toBe(document);
  });
});

describe("CompositionBuilder: constructor throws SceneBuilderUsageError for an ambiguous size", () => {
  it("throws when both size and flat width/height are somehow both present", () => {
    expect(
      () =>
        new CompositionBuilder(
          // Deliberately bypasses the union type via a loosely-typed object
          // literal, mirroring how an agent might assemble props dynamically
          // without going through the strict TypeScript overload.
          {
            id: "c",
            name: "Main",
            fps: 30,
            durationInFrames: 30,
            size: { width: 1, height: 1 },
            width: 2,
            height: 2,
          } as never,
          noopBuild,
        ),
    ).toThrow(SceneBuilderUsageError);
  });

  it("throws when neither size nor width/height is present", () => {
    expect(
      () =>
        new CompositionBuilder(
          { id: "c", name: "Main", fps: 30, durationInFrames: 30 } as never,
          noopBuild,
        ),
    ).toThrow(SceneBuilderUsageError);
  });

  it("throws when only width is present without height", () => {
    expect(
      () =>
        new CompositionBuilder(
          { id: "c", name: "Main", fps: 30, durationInFrames: 30, width: 640 } as never,
          noopBuild,
        ),
    ).toThrow(SceneBuilderUsageError);
  });

  it("throws when only height is present without width", () => {
    expect(
      () =>
        new CompositionBuilder(
          { id: "c", name: "Main", fps: 30, durationInFrames: 30, height: 360 } as never,
          noopBuild,
        ),
    ).toThrow(SceneBuilderUsageError);
  });

  it("throws (rather than silently producing an undefined width/height) when 'size' is present but its value is undefined", () => {
    // Only reachable by bypassing CompositionBuilderProps' union type (the
    // "size" in props check proves the key exists, not that its value is a
    // real CompositionSize), mirroring how an agent assembling props
    // dynamically might still hand over a key with an undefined value.
    expect(
      () =>
        new CompositionBuilder(
          { id: "c", name: "Main", fps: 30, durationInFrames: 30, size: undefined } as never,
          noopBuild,
        ),
    ).toThrow(SceneBuilderUsageError);
  });
});
