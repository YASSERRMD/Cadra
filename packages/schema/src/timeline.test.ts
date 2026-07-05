import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { clipSchema, compositionSchema, projectSchema, trackSchema } from "./timeline.js";

function sampleNode() {
  return {
    id: "node-1",
    kind: "group" as const,
    transform: createIdentityTransform(),
    visible: true,
    children: [],
  };
}

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
