import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "./primitives.js";
import type { SceneNode } from "./scene-node.js";
import type { Project } from "./timeline.js";

/**
 * These tests exist to guarantee the scene graph is plain serializable data:
 * every value must survive `structuredClone` (the same mechanism used to
 * send data across a worker or MCP boundary) with full deep equality. If a
 * class instance, function, or exotic object ever leaks into this model,
 * `structuredClone` either throws or silently drops it, and these tests
 * catch that regression.
 */

function makeSampleSceneNode(): SceneNode {
  return {
    id: "root",
    kind: "group",
    name: "Root",
    transform: createIdentityTransform(),
    visible: true,
    children: [
      {
        id: "cam-1",
        kind: "camera",
        transform: {
          position: [0, 1, 5],
          rotation: [0, Math.PI, 0],
          scale: [1, 1, 1],
        },
        visible: true,
        fov: 50,
        near: 0.1,
        far: 1000,
        target: [0, 0, 0],
        children: [],
      },
      {
        id: "text-1",
        kind: "text",
        transform: createIdentityTransform(),
        visible: true,
        content: "Hello, Cadra",
        fontSize: 48,
        color: [1, 1, 1, 1],
        children: [
          {
            id: "nested-ref",
            kind: "compositionRef",
            transform: createIdentityTransform(),
            visible: true,
            compositionId: "intro-comp",
            children: [],
          },
        ],
      },
    ],
  };
}

function makeSampleProject(): Project {
  return {
    id: "project-1",
    name: "Sample Project",
    compositions: [
      {
        id: "comp-1",
        name: "Main",
        fps: 30,
        durationInFrames: 300,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-1",
            name: "Primary",
            clips: [
              {
                id: "clip-1",
                startFrame: 0,
                durationInFrames: 90,
                node: makeSampleSceneNode(),
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("structuredClone round trip", () => {
  it("preserves deep equality for a SceneNode subtree", () => {
    const original = makeSampleSceneNode();
    const cloned = structuredClone(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });

  it("preserves deep equality for a full Project", () => {
    const original = makeSampleProject();
    const cloned = structuredClone(original);

    expect(cloned).toEqual(original);
    expect(cloned).not.toBe(original);
  });

  it("round trips through JSON with identical shape", () => {
    const original = makeSampleProject();
    const roundTripped = JSON.parse(JSON.stringify(original)) as Project;

    expect(roundTripped).toEqual(original);
  });
});
