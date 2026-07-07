import { createIdentityTransform, type Transform } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";
import { CURRENT_SCHEMA_VERSION } from "@cadra/schema";
import { describe, expect, it } from "vitest";

import { createFakeDocumentPersistence } from "./persistence/fake-document-persistence.js";
import { commitNodeTransform } from "./store/document-edits.js";
import { createDocumentStore } from "./store/document-store.js";

const COMPOSITION_ID = "comp-1";
const TRACK_ID = "track-1";
const CLIP_ID = "clip-1";
const NODE_ID = "shared-node";

/** A small, valid starting document with one composition/track/clip, whose root node is a plain group at the identity transform - the exact known starting state both convergence paths below start from. */
function buildStartingDocument(): SceneDocument {
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

/**
 * Proves this phase's own central acceptance criterion: a viewport gizmo
 * edit and a manual DSL/JSON panel edit are two different UI surfaces that
 * both funnel through the exact same `commitDocument`, so applying the
 * identical logical edit (the same node's transform, set to the same new
 * value) through either surface converges on the same committed document -
 * neither surface maintains a second, parallel way of mutating `document`
 * that could silently drift from the other.
 *
 * Path A (the gizmo path) calls `commitNodeTransform` directly - the exact
 * same standalone function `Viewport.tsx`'s own gizmo-attach effect calls
 * from inside `attachTransformGizmo`'s `onTransformChange` callback (see
 * that component's own doc and `../store/document-edits.js`'s doc for
 * `commitNodeTransform`) - rather than driving a real `TransformControls`
 * drag through a real `Renderer`/`THREE.Scene`/camera, which (per this
 * phase's own design note) is not meaningfully exercisable in this
 * jsdom/Vitest environment (no real WebGL/WebGPU context, no real
 * pointer-drag-in-3D-space). This is the identical seam
 * `attach-transform-gizmo.test.ts` (in `@cadra/renderer`) already tests the
 * *other* half of: that test proves `attachTransformGizmo` really calls its
 * `onTransformChange` callback with the dragged object's real final
 * `Transform` on drag release; this test proves that whatever `Transform`
 * that callback is given ends up committed via the exact same document-edit
 * path a manual DSL edit would also produce.
 *
 * Path B (the DSL panel path) mirrors `DslPanel.tsx`'s own `applyEdit`
 * exactly: `JSON.parse` a candidate document's text, then call
 * `commitDocument` with the parsed result - the same two steps that
 * function performs, just invoked directly here instead of through a
 * rendered `<textarea>`, for the same "test the pure data-flow wiring, not
 * DOM event simulation of a plain textarea" reason `attachTransformGizmo`'s
 * own convergence half is tested this way.
 *
 * Both paths start from two independent store instances seeded with the
 * exact same starting document, so any divergence between the two paths
 * would only be attributable to the paths themselves, never to some
 * incidental difference in starting state.
 */
describe("gizmo edit and DSL panel edit converge on the same committed document", () => {
  it("produces deep-equal committed documents for the identical logical transform edit", () => {
    const startingDocument = buildStartingDocument();
    const newTransform: Transform = {
      position: [10, 20, 30],
      rotation: [0.1, 0.2, 0.3],
      scale: [2, 2, 2],
    };

    // --- Path A: the gizmo path ---
    const gizmoStore = createDocumentStore(createFakeDocumentPersistence());
    const seededA = gizmoStore.getState().commitDocument(startingDocument);
    expect(seededA).toBe(true);

    const gizmoCommitResult = commitNodeTransform(
      gizmoStore.getState().document,
      NODE_ID,
      newTransform,
      gizmoStore.getState().commitDocument,
    );
    expect(gizmoCommitResult).toBe(true);
    const documentA = gizmoStore.getState().document;

    // --- Path B: the DSL panel path ---
    const dslStore = createDocumentStore(createFakeDocumentPersistence());
    const seededB = dslStore.getState().commitDocument(startingDocument);
    expect(seededB).toBe(true);

    // The exact same splice replaceNodeInDocument/commitNodeTransform
    // perform internally, but expressed here as literal JSON text (what a
    // user would actually type/paste into DslPanel's own textarea), proving
    // the DSL panel's *own* commit mechanism (JSON.parse + commitDocument,
    // with no bespoke node-transform-specific logic of its own) reaches the
    // identical result.
    const candidateDslDocument: SceneDocument = {
      ...startingDocument,
      project: {
        ...startingDocument.project,
        compositions: startingDocument.project.compositions.map((composition) =>
          composition.id !== COMPOSITION_ID
            ? composition
            : {
                ...composition,
                tracks: composition.tracks.map((track) =>
                  track.id !== TRACK_ID
                    ? track
                    : {
                        ...track,
                        clips: track.clips.map((clip) =>
                          clip.id !== CLIP_ID
                            ? clip
                            : { ...clip, node: { ...clip.node, transform: newTransform } },
                        ),
                      },
                ),
              },
        ),
      },
    };
    const dslJsonText = JSON.stringify(candidateDslDocument, null, 2);
    const parsedFromDsl: unknown = JSON.parse(dslJsonText);
    const dslCommitResult = dslStore.getState().commitDocument(parsedFromDsl);
    expect(dslCommitResult).toBe(true);
    const documentB = dslStore.getState().document;

    // The central assertion: both editing surfaces converge on one state,
    // not merely "each works in isolation".
    expect(documentA).toEqual(documentB);

    // Also asserted narrowly (the minimum this phase's own spec calls for),
    // so a future change to some *unrelated* field this test does not
    // otherwise pin down still fails loudly and specifically on the
    // transform itself, not just on the broader deep-equal above.
    const nodeATransform = documentA.project.compositions[0]?.tracks[0]?.clips[0]?.node.transform;
    const nodeBTransform = documentB.project.compositions[0]?.tracks[0]?.clips[0]?.node.transform;
    expect(nodeATransform).toEqual(newTransform);
    expect(nodeBTransform).toEqual(newTransform);
  });
});
