import type { Clip, SceneNode } from "@cadra/core";
import { findNode } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";

/** A clip located somewhere in `document`, plus which composition/track it was found in (needed to splice an edit back via `commitDocument`; see `InspectorPanel`). */
export interface SelectedClipMatch {
  compositionId: string;
  trackId: string;
  clip: Clip;
  /** The exact `SceneNode` (possibly a descendant of `clip.node`, not necessarily `clip.node` itself) whose id matches `nodeId`. */
  node: SceneNode;
}

/**
 * Searches every composition's every track's every clip's node subtree for
 * one matching `nodeId`, returning the owning clip (and composition id)
 * alongside the exact matched node.
 *
 * `TimelinePanel`'s own selection mechanism (Phase 39's prerequisite) only
 * ever selects a clip's *root* node id (see that component's
 * `handleDocumentMouseUp`), so in practice `node` returned here is always
 * `=== match.clip.node` for every selection this app itself ever produces.
 * This still searches the full subtree (via `findNode`, which itself
 * recurses into `children`) rather than only checking `clip.node.id`
 * directly, since `selectedNodeId` is a plain store field nothing else
 * constrains to "must be a clip root": a future selection mechanism (e.g.
 * clicking a node in a scene-graph tree view) could reasonably select a
 * descendant node instead, and this lookup already being correct for that
 * case costs nothing extra here.
 *
 * Returns `undefined` if no clip anywhere in `document` has a node matching
 * `nodeId` (e.g. `selectedNodeId` is `undefined`, or the store's own
 * `applyDocument` has not yet cleared a selection that no longer exists,
 * a state `InspectorPanel` treats identically to "nothing selected").
 */
export function findSelectedClip(
  document: SceneDocument,
  nodeId: string | undefined,
): SelectedClipMatch | undefined {
  if (nodeId === undefined) {
    return undefined;
  }

  for (const composition of document.project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        const node = findNode(clip.node, nodeId);
        if (node !== undefined) {
          return { compositionId: composition.id, trackId: track.id, clip, node };
        }
      }
    }
  }
  return undefined;
}
