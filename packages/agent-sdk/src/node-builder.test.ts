import { createIdentityTransform, type SceneNode } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { SceneBuilderUsageError } from "./errors.js";
import { NodeBuilder } from "./node-builder.js";

function groupNode(id: string): SceneNode {
  return { id, kind: "group", transform: createIdentityTransform(), visible: true, children: [] };
}

describe("NodeBuilder.animateTransform", () => {
  it("sets only the requested transform fields, leaving the others as plain constants", () => {
    const builder = new NodeBuilder(groupNode("n1")).animateTransform({
      position: [
        { frame: 0, value: [0, 0, 0] },
        { frame: 10, value: [1, 2, 3] },
      ],
    });

    expect(builder.node.transform.position).toEqual({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: [0, 0, 0] },
        { frame: 10, value: [1, 2, 3] },
      ],
    });
    expect(builder.node.transform.rotation).toEqual([0, 0, 0]);
    expect(builder.node.transform.scale).toEqual([1, 1, 1]);
  });

  it("sets multiple transform fields in one call", () => {
    const builder = new NodeBuilder(groupNode("n1")).animateTransform({
      position: [{ frame: 0, value: [1, 1, 1] }],
      scale: [{ frame: 0, value: [2, 2, 2] }],
    });

    expect(builder.node.transform.position).toEqual({
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: [1, 1, 1] }],
    });
    expect(builder.node.transform.scale).toEqual({
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: [2, 2, 2] }],
    });
  });

  it("chains: a later animateTransform call does not clobber an earlier one's other fields", () => {
    const builder = new NodeBuilder(groupNode("n1"))
      .animateTransform({ position: [{ frame: 0, value: [9, 9, 9] }] })
      .animateTransform({ scale: [{ frame: 0, value: [5, 5, 5] }] });

    expect(builder.node.transform.position).toEqual({
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: [9, 9, 9] }],
    });
    expect(builder.node.transform.scale).toEqual({
      type: "keyframeTrack",
      keyframes: [{ frame: 0, value: [5, 5, 5] }],
    });
  });
});

describe("NodeBuilder.animateVisible", () => {
  it("sets visible to a keyframe track", () => {
    const builder = new NodeBuilder(groupNode("n1")).animateVisible([
      { frame: 0, value: true, easing: "hold" },
      { frame: 30, value: false },
    ]);

    expect(builder.node.visible).toEqual({
      type: "keyframeTrack",
      keyframes: [
        { frame: 0, value: true, easing: "hold" },
        { frame: 30, value: false },
      ],
    });
  });
});

describe("NodeBuilder.at", () => {
  it("produces a Clip with the given startFrame/durationInFrames and the node itself", () => {
    const node = groupNode("n1");
    const { clip } = new NodeBuilder(node).at(5, 20);

    expect(clip).toEqual({
      id: "n1-clip",
      startFrame: 5,
      durationInFrames: 20,
      node,
    });
  });

  it("uses a caller-provided clipId instead of the default derived one", () => {
    const { clip } = new NodeBuilder(groupNode("n1")).at(0, 10, { clipId: "custom-clip" });
    expect(clip.id).toBe("custom-clip");
  });

  it("includes transitionIn only when provided", () => {
    const withoutTransition = new NodeBuilder(groupNode("n1")).at(0, 10);
    expect("transitionIn" in withoutTransition.clip).toBe(false);

    const withTransition = new NodeBuilder(groupNode("n2")).at(0, 10, {
      transitionIn: { type: "fade", durationInFrames: 5 },
    });
    expect(withTransition.clip.transitionIn).toEqual({ type: "fade", durationInFrames: 5 });
  });

  it("throws SceneBuilderUsageError for a negative startFrame", () => {
    expect(() => new NodeBuilder(groupNode("n1")).at(-1, 10)).toThrow(SceneBuilderUsageError);
  });

  it("throws SceneBuilderUsageError for a non-integer startFrame", () => {
    expect(() => new NodeBuilder(groupNode("n1")).at(1.5, 10)).toThrow(SceneBuilderUsageError);
  });

  it("throws SceneBuilderUsageError for a zero durationInFrames", () => {
    expect(() => new NodeBuilder(groupNode("n1")).at(0, 0)).toThrow(SceneBuilderUsageError);
  });

  it("throws SceneBuilderUsageError for a negative durationInFrames", () => {
    expect(() => new NodeBuilder(groupNode("n1")).at(0, -5)).toThrow(SceneBuilderUsageError);
  });

  it("throws SceneBuilderUsageError for a non-integer durationInFrames", () => {
    expect(() => new NodeBuilder(groupNode("n1")).at(0, 10.5)).toThrow(SceneBuilderUsageError);
  });

  it("accepts startFrame 0 (the smallest valid value)", () => {
    expect(() => new NodeBuilder(groupNode("n1")).at(0, 1)).not.toThrow();
  });
});
