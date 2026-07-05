import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  activeCameraEntrySchema,
  clipSchema,
  compositionSchema,
  projectSchema,
  trackSchema,
  transitionSchema,
} from "./timeline.js";

function sampleNode() {
  return {
    id: "node-1",
    kind: "group" as const,
    transform: createIdentityTransform(),
    visible: true,
    children: [],
  };
}

describe("transitionSchema", () => {
  it("accepts a fade transition with no direction", () => {
    const result = transitionSchema.safeParse({ type: "fade", durationInFrames: 15 });
    expect(result.success).toBe(true);
  });

  it("accepts a crossDissolve transition with no direction", () => {
    const result = transitionSchema.safeParse({ type: "crossDissolve", durationInFrames: 20 });
    expect(result.success).toBe(true);
  });

  it("accepts a wipe transition with a direction", () => {
    const result = transitionSchema.safeParse({
      type: "wipe",
      durationInFrames: 10,
      direction: "left",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wipe transition missing direction", () => {
    const result = transitionSchema.safeParse({ type: "wipe", durationInFrames: 10 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) => candidate.path.join(".") === "direction",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/requires a 'direction'/);
    }
  });

  it("rejects a fade transition with a direction present", () => {
    const result = transitionSchema.safeParse({
      type: "fade",
      durationInFrames: 10,
      direction: "up",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) => candidate.path.join(".") === "direction",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/only meaningful for a 'wipe' transition/);
    }
  });

  it("rejects a crossDissolve transition with a direction present", () => {
    const result = transitionSchema.safeParse({
      type: "crossDissolve",
      durationInFrames: 10,
      direction: "down",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive durationInFrames", () => {
    expect(transitionSchema.safeParse({ type: "fade", durationInFrames: 0 }).success).toBe(false);
    expect(transitionSchema.safeParse({ type: "fade", durationInFrames: -5 }).success).toBe(false);
  });

  it("rejects an unrecognized transition type", () => {
    const result = transitionSchema.safeParse({ type: "sparkle", durationInFrames: 10 });
    expect(result.success).toBe(false);
  });
});

describe("clipSchema", () => {
  it("accepts a clip with startFrame 0", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 0,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative startFrame", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: -1,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer startFrame", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 1.5,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a durationInFrames of 0 (must be strictly positive)", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 0,
      durationInFrames: 0,
      node: sampleNode(),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a clip with no transitionIn (an implicit cut)", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 0,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts a clip with a valid crossDissolve transitionIn", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 30,
      durationInFrames: 30,
      node: sampleNode(),
      transitionIn: { type: "crossDissolve", durationInFrames: 10 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a clip whose transitionIn is an invalid wipe missing direction", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 30,
      durationInFrames: 30,
      node: sampleNode(),
      transitionIn: { type: "wipe", durationInFrames: 10 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("transitionIn.direction"),
      );
      expect(issue).toBeDefined();
    }
  });

  it("rejects a clip whose transitionIn has a non-positive durationInFrames", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 30,
      durationInFrames: 30,
      node: sampleNode(),
      transitionIn: { type: "fade", durationInFrames: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("activeCameraEntrySchema", () => {
  it("accepts a valid entry", () => {
    const result = activeCameraEntrySchema.safeParse({
      startFrame: 0,
      durationInFrames: 60,
      cameraNodeId: "camera-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative startFrame", () => {
    const result = activeCameraEntrySchema.safeParse({
      startFrame: -1,
      durationInFrames: 60,
      cameraNodeId: "camera-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive durationInFrames", () => {
    const result = activeCameraEntrySchema.safeParse({
      startFrame: 0,
      durationInFrames: 0,
      cameraNodeId: "camera-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("trackSchema", () => {
  it("accepts a track with an empty clips array", () => {
    const result = trackSchema.safeParse({ id: "track-1", clips: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a track name as optional", () => {
    const result = trackSchema.safeParse({ id: "track-1", name: "Primary", clips: [] });
    expect(result.success).toBe(true);
  });
});

describe("compositionSchema", () => {
  function validComposition() {
    return {
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      tracks: [],
    };
  }

  it("accepts a fully valid composition", () => {
    expect(compositionSchema.safeParse(validComposition()).success).toBe(true);
  });

  it("rejects a non-integer fps", () => {
    const result = compositionSchema.safeParse({ ...validComposition(), fps: 29.97 });
    expect(result.success).toBe(false);
  });

  it("rejects a zero or negative fps", () => {
    expect(compositionSchema.safeParse({ ...validComposition(), fps: 0 }).success).toBe(false);
    expect(compositionSchema.safeParse({ ...validComposition(), fps: -30 }).success).toBe(false);
  });

  it("rejects a non-integer durationInFrames", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      durationInFrames: 100.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer width or height", () => {
    expect(compositionSchema.safeParse({ ...validComposition(), width: 1920.5 }).success).toBe(
      false,
    );
    expect(compositionSchema.safeParse({ ...validComposition(), height: 1080.5 }).success).toBe(
      false,
    );
  });

  it("rejects a zero width or height", () => {
    expect(compositionSchema.safeParse({ ...validComposition(), width: 0 }).success).toBe(false);
    expect(compositionSchema.safeParse({ ...validComposition(), height: 0 }).success).toBe(false);
  });

  it("accepts a composition with an activeCameraTrack", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      activeCameraTrack: [
        { startFrame: 0, durationInFrames: 60, cameraNodeId: "camera-a" },
        { startFrame: 60, durationInFrames: 60, cameraNodeId: "camera-b" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a composition whose activeCameraTrack has an invalid entry", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      activeCameraTrack: [{ startFrame: 0, durationInFrames: -1, cameraNodeId: "camera-a" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("projectSchema", () => {
  it("accepts a project with an empty compositions array", () => {
    const result = projectSchema.safeParse({ id: "p1", name: "My Project", compositions: [] });
    expect(result.success).toBe(true);
  });

  it("rejects a project missing an id", () => {
    const result = projectSchema.safeParse({ name: "My Project", compositions: [] });
    expect(result.success).toBe(false);
  });
});
