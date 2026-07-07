import type { Composition, SceneNode, Transform } from "@cadra/core";
import { updateNode } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";

import type { SelectedClipMatch } from "../inspector/find-selected-clip.js";
import { findSelectedClip } from "../inspector/find-selected-clip.js";

/**
 * Returns a new `SceneDocument` equal to `sceneDocument` except that the
 * composition matching `compositionId` is replaced by `nextComposition`.
 *
 * A small, local, document-envelope-level splice (distinct from
 * `@cadra/core`'s own tree/clip operations, which operate one level down):
 * this is what turns "a new `Composition` with something inside it changed"
 * into the full candidate `SceneDocument` `commitDocument` expects.
 * Immutable; does not mutate `sceneDocument`.
 *
 * Originally introduced (Phase 38) as a private helper inside
 * `TimelinePanel.tsx` for its own clip drag/trim/reorder edits; extracted
 * here (Phase 39) so `InspectorPanel.tsx`'s property/keyframe edits - which
 * need the exact same "splice an updated Composition back into the
 * document" step, just with a different one-level-down mutation
 * (`updateNode` on the selected clip's node tree, rather than
 * `updateClipTiming`/`moveClipToTrack`) - can reuse it verbatim instead of
 * duplicating it.
 */
export function replaceComposition(
  sceneDocument: SceneDocument,
  compositionId: string,
  nextComposition: Composition,
): SceneDocument {
  return {
    ...sceneDocument,
    project: {
      ...sceneDocument.project,
      compositions: sceneDocument.project.compositions.map((composition) =>
        composition.id === compositionId ? nextComposition : composition,
      ),
    },
  };
}

/**
 * Returns a new `SceneDocument` equal to `sceneDocument` except that the
 * node matching `match.node.id` (found via `findSelectedClip`, see
 * `../inspector/find-selected-clip.js`) is replaced by `nextNode`, within
 * that same clip/track/composition.
 *
 * The one splice `InspectorPanel`'s property/keyframe edits need, all the
 * way from a single updated `SceneNode` back up to a full candidate
 * `SceneDocument`: `updateNode` (Phase 3's structural-sharing tree
 * operation) replaces the node within `match.clip.node`'s own subtree, the
 * result becomes the clip's new `node`, that clip is spliced back into its
 * `Track` (found by `match.trackId`), and the containing `Composition` is
 * spliced back into `sceneDocument` via `replaceComposition`. Immutable at
 * every level; does not mutate `sceneDocument`, `match.clip`, or any node in
 * `match.clip.node`'s subtree.
 *
 * @throws if `match.compositionId` does not name a composition actually in
 *   `sceneDocument`, or if `updateNode` cannot find `match.node.id` inside
 *   `match.clip.node` (both would mean `match` was computed against a
 *   different document than `sceneDocument`, which no caller in this app
 *   ever does: `InspectorPanel` always computes `match` from the exact same
 *   `document` it then passes here as `sceneDocument`).
 */
export function replaceNodeInDocument(
  sceneDocument: SceneDocument,
  match: SelectedClipMatch,
  nextNode: SceneNode,
): SceneDocument {
  const composition = sceneDocument.project.compositions.find(
    (candidate) => candidate.id === match.compositionId,
  );
  if (composition === undefined) {
    throw new Error(
      `replaceNodeInDocument: no composition with id "${match.compositionId}" in the given document.`,
    );
  }

  const nextClipNodeRoot = updateNode(match.clip.node, match.node.id, () => nextNode);
  const nextComposition: Composition = {
    ...composition,
    tracks: composition.tracks.map((track) =>
      track.id !== match.trackId
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) =>
              clip.id === match.clip.id ? { ...clip, node: nextClipNodeRoot } : clip,
            ),
          },
    ),
  };

  return replaceComposition(sceneDocument, match.compositionId, nextComposition);
}

/**
 * Commits a single node's new `Transform` (e.g. the final result of one
 * completed viewport gizmo drag; see `Viewport.tsx`'s own `attachTransformGizmo`
 * wiring, which calls this directly) into `sceneDocument`, via
 * `commitDocument`.
 *
 * This is the exact splice `attachTransformGizmo`'s `onTransformChange`
 * needs, all the way from "a node id plus its new `Transform`" to an actual
 * `commitDocument` call: looks the node up via `findSelectedClip` (the same
 * tree walk every other selection lookup in this app already uses),
 * replaces its `transform` field (a plain `Transform` is always a valid
 * `AnimatableTransform`; see `@cadra/core`'s own `primitives.ts` doc for why
 * this assignment needs no conversion), splices the result back into a full
 * candidate document via `replaceNodeInDocument`, and calls `commitDocument`
 * with it.
 *
 * Extracted as its own small, pure, exported function (rather than staying
 * a private closure inside `Viewport.tsx`'s own gizmo-attach effect) so it
 * has exactly one implementation that both `Viewport.tsx` (wiring a real
 * gizmo drag to a real `commitDocument`) and this app's own convergence test
 * (`convergence.test.ts`, proving a gizmo edit and a DSL panel edit commit
 * identical documents) call directly, rather than the test re-implementing
 * this splice a second, parallel way that could silently drift from what
 * `Viewport.tsx` actually does.
 *
 * A no-op (returns `false`, matching `commitDocument`'s own "rejected"
 * return value) if `nodeId` does not resolve to any node in `sceneDocument`
 * (e.g. it was deleted by an edit that landed after a gizmo was attached to
 * it, but before the in-progress drag ended): `findSelectedClip` returning
 * `undefined` is treated as "nothing to commit", not an error, exactly the
 * same posture `Viewport.tsx`'s own former inline `commitTransform` took.
 */
export function commitNodeTransform(
  sceneDocument: SceneDocument,
  nodeId: string,
  transform: Transform,
  commitDocument: (candidate: unknown) => boolean,
): boolean {
  const match = findSelectedClip(sceneDocument, nodeId);
  if (match === undefined) {
    return false;
  }
  const nextNode: SceneNode = { ...match.node, transform };
  const candidate = replaceNodeInDocument(sceneDocument, match, nextNode);
  return commitDocument(candidate);
}
