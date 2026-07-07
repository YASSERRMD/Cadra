import type { Composition, SceneNode } from "@cadra/core";
import { updateNode } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";

import type { SelectedClipMatch } from "../inspector/find-selected-clip.js";

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
