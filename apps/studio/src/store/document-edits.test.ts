import { createIdentityTransform, type Transform } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";
import { CURRENT_SCHEMA_VERSION } from "@cadra/schema";
import { describe, expect, it, vi } from "vitest";

import { commitNodeTransform } from "./document-edits.js";

const COMPOSITION_ID = "comp-1";
const TRACK_ID = "track-1";
const CLIP_ID = "clip-1";
const NODE_ID = "node-1";

/** A document with one composition/track/clip, whose root node is a plain group at the identity transform. */
function buildDocument(): SceneDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: "project-1",
      name: "Project",
      compositions: [
        {
          id: COMPOSITION_ID,
          name: "Comp",
          fps: 30,
          durationInFrames: 100,
          width: 1920,
          height: 1080,
          tracks: [
            {
              id: TRACK_ID,
              clips: [
                {
                  id: CLIP_ID,
                  startFrame: 0,
                  durationInFrames: 100,
                  node: {
                    id: NODE_ID,
                    kind: "group",
                    transform: createIdentityTransform(),
                    visible: true,
                    children: [],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe("commitNodeTransform", () => {
  it("commits a candidate document with the node's transform replaced", () => {
    const document = buildDocument();
    const nextTransform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const commitDocument = vi.fn((_candidate: unknown) => true);

    const result = commitNodeTransform(document, NODE_ID, nextTransform, commitDocument);

    expect(result).toBe(true);
    expect(commitDocument).toHaveBeenCalledTimes(1);
    const candidate = commitDocument.mock.calls[0]?.[0] as SceneDocument;
    const committedNode = candidate.project.compositions[0]?.tracks[0]?.clips[0]?.node;
    expect(committedNode?.transform).toEqual(nextTransform);
  });

  it("does not mutate the original document", () => {
    const document = buildDocument();
    const originalTransform = document.project.compositions[0]?.tracks[0]?.clips[0]?.node.transform;
    const nextTransform: Transform = { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const commitDocument = vi.fn((_candidate: unknown) => true);

    commitNodeTransform(document, NODE_ID, nextTransform, commitDocument);

    expect(document.project.compositions[0]?.tracks[0]?.clips[0]?.node.transform).toBe(
      originalTransform,
    );
  });

  it("returns false and does not call commitDocument when nodeId does not exist in the document", () => {
    const document = buildDocument();
    const nextTransform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const commitDocument = vi.fn((_candidate: unknown) => true);

    const result = commitNodeTransform(document, "no-such-node", nextTransform, commitDocument);

    expect(result).toBe(false);
    expect(commitDocument).not.toHaveBeenCalled();
  });

  it("propagates commitDocument's own return value (false on a rejected edit)", () => {
    const document = buildDocument();
    const nextTransform: Transform = { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const commitDocument = vi.fn((_candidate: unknown) => false);

    const result = commitNodeTransform(document, NODE_ID, nextTransform, commitDocument);

    expect(result).toBe(false);
    expect(commitDocument).toHaveBeenCalledTimes(1);
  });
});
