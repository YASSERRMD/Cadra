import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "../scene-graph/primitives.js";
import { deriveSequenceRootId, resolveSequenceFrame, Sequence } from "./sequence.js";
import { Shape } from "./shape.js";

describe("Sequence", () => {
  it("produces a Clip whose node is the single content node unchanged", () => {
    const content = Shape({ id: "shape-1" });

    const clip = Sequence({ id: "seq-1", from: 10, durationInFrames: 30, content });

    expect(clip).toEqual({
      id: "seq-1",
      startFrame: 10,
      durationInFrames: 30,
      node: content,
    });
  });

  it("wraps multiple content nodes in a group node with a derived id", () => {
    const a = Shape({ id: "shape-a" });
    const b = Shape({ id: "shape-b" });

    const clip = Sequence({ id: "seq-2", from: 0, durationInFrames: 20, content: [a, b] });

    expect(clip.node).toEqual({
      id: deriveSequenceRootId("seq-2"),
      kind: "group",
      transform: createIdentityTransform(),
      visible: true,
      children: [a, b],
    });
  });

  it("derives the same wrapper id for the same clip id every time (pure, no hidden counter)", () => {
    expect(deriveSequenceRootId("clip-x")).toBe(deriveSequenceRootId("clip-x"));
    expect(deriveSequenceRootId("clip-x")).toBe("clip-x-root");
  });

  it("maps from to startFrame directly", () => {
    const clip = Sequence({ id: "seq-3", from: 42, durationInFrames: 5, content: Shape({ id: "s" }) });

    expect(clip.startFrame).toBe(42);
    expect(clip.durationInFrames).toBe(5);
  });
});

describe("resolveSequenceFrame", () => {
  const sequence = { startFrame: 10, durationInFrames: 5 };

  it("is not visible one frame before startFrame", () => {
    expect(resolveSequenceFrame(sequence, 9)).toEqual({ visible: false, localFrame: -1 });
  });

  it("is visible at exactly startFrame, with localFrame 0", () => {
    expect(resolveSequenceFrame(sequence, 10)).toEqual({ visible: true, localFrame: 0 });
  });

  it("is visible on the last visible frame (startFrame + durationInFrames - 1)", () => {
    expect(resolveSequenceFrame(sequence, 14)).toEqual({ visible: true, localFrame: 4 });
  });

  it("is not visible at exactly startFrame + durationInFrames (exclusive end boundary)", () => {
    expect(resolveSequenceFrame(sequence, 15)).toEqual({ visible: false, localFrame: 5 });
  });

  it("is not visible well before or well after the window", () => {
    expect(resolveSequenceFrame(sequence, 0).visible).toBe(false);
    expect(resolveSequenceFrame(sequence, 1000).visible).toBe(false);
  });

  it("handles a sequence starting at frame 0", () => {
    const atZero = { startFrame: 0, durationInFrames: 1 };
    expect(resolveSequenceFrame(atZero, 0)).toEqual({ visible: true, localFrame: 0 });
    expect(resolveSequenceFrame(atZero, 1)).toEqual({ visible: false, localFrame: 1 });
    expect(resolveSequenceFrame(atZero, -1)).toEqual({ visible: false, localFrame: -1 });
  });
});
