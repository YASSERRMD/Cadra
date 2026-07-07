/**
 * Outer navigation for applying one `SceneNode`-level tree operation
 * (`addNode`/`updateNode`/`removeNode` from `@cadra/core`) to the right spot
 * inside a whole `Project`, plus the `update_scene` "patch" mode operations
 * themselves.
 *
 * `@cadra/core`'s tree operations are pure and structural-sharing, but they
 * only know how to operate on a single `SceneNode` subtree (a `Clip.node`);
 * nothing in `@cadra/core` walks `Project -> Composition -> Track -> Clip` to
 * find which clip's node tree actually contains a given node id. This module
 * is exactly that outer traversal: it locates the one clip (searching every
 * composition/track/clip in the project) whose node tree contains a given
 * "anchor" id (the parent for `addNode`, the target node itself for
 * `updateNode`/`removeNode`), applies the given tree operation to that
 * clip's `node`, and splices the updated clip back into a brand-new
 * `Project` object, leaving every other composition/track/clip's object
 * reference untouched.
 */
import type { Clip, Composition, Project, SceneNode, Track } from "@cadra/core";
import { addNode, findNode, removeNode, updateNode } from "@cadra/core";

import type { ScenePatchOperation } from "./scene-patch-schema.js";

/** Thrown when no clip in the project's node trees contains the given anchor node id (the parent id for `addNode`, the target id for `updateNode`/`removeNode`). */
export class PatchNodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(
      `No scene node with id "${nodeId}" was found in any clip of this project. ` +
        "Check the id against get_scene's current document before patching.",
    );
    this.name = "PatchNodeNotFoundError";
  }
}

/** Thrown by an `addNode` patch operation whose new node's `id` already exists somewhere in the project. */
export class DuplicateNodeIdError extends Error {
  constructor(nodeId: string) {
    super(
      `A scene node with id "${nodeId}" already exists in this project. Node ids must be ` +
        "unique across the whole project; choose a different id for the new node.",
    );
    this.name = "DuplicateNodeIdError";
  }
}

/**
 * Locates the clip (by composition index, track index, clip index) whose
 * `node` tree contains a node with id `nodeId`, searching every composition,
 * track, and clip of `project` in order. Returns `undefined` if no clip's
 * tree contains that id.
 */
function locateClipContainingNode(
  project: Project,
  nodeId: string,
): { compositionIndex: number; trackIndex: number; clipIndex: number } | undefined {
  for (
    let compositionIndex = 0;
    compositionIndex < project.compositions.length;
    compositionIndex += 1
  ) {
    const composition = project.compositions[compositionIndex]!;
    for (let trackIndex = 0; trackIndex < composition.tracks.length; trackIndex += 1) {
      const track = composition.tracks[trackIndex]!;
      for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex += 1) {
        const clip = track.clips[clipIndex]!;
        if (findNode(clip.node, nodeId) !== undefined) {
          return { compositionIndex, trackIndex, clipIndex };
        }
      }
    }
  }
  return undefined;
}

/**
 * True if any clip's node tree anywhere in `project` contains a node with id
 * `nodeId`. Exported (beyond this module's own `addNode` duplicate-id check)
 * so any other caller minting a brand-new node id against an existing
 * project - e.g. `generation-clip-tools.ts`'s `add_generated_clip`,
 * inserting a whole new `Clip`/`VideoNode` outside this module's own
 * node-level patch operations - can check for a collision the exact same
 * way, rather than re-deriving this same traversal independently.
 */
export function projectContainsNodeId(project: Project, nodeId: string): boolean {
  return locateClipContainingNode(project, nodeId) !== undefined;
}

/**
 * Returns a new `Project` equal to `project` except that the clip whose node
 * tree contains `anchorNodeId` has had `applyToNode` applied to its `node`.
 *
 * Uses the same structural-sharing discipline `@cadra/core`'s tree
 * operations follow: only the path down to the matched clip (its
 * composition's `compositions` array and object, its track's `tracks` array
 * and object, its `clips` array and the clip itself) is newly allocated.
 * Every other composition, track, and clip keeps its exact original object
 * reference. `project` is never mutated.
 *
 * @throws {PatchNodeNotFoundError} if no clip's node tree contains `anchorNodeId`.
 */
function applyNodeOperationToProject(
  project: Project,
  anchorNodeId: string,
  applyToNode: (node: SceneNode) => SceneNode,
): Project {
  const location = locateClipContainingNode(project, anchorNodeId);
  if (location === undefined) {
    throw new PatchNodeNotFoundError(anchorNodeId);
  }
  const { compositionIndex, trackIndex, clipIndex } = location;

  const composition = project.compositions[compositionIndex]!;
  const track = composition.tracks[trackIndex]!;
  const clip = track.clips[clipIndex]!;

  const updatedClip: Clip = { ...clip, node: applyToNode(clip.node) };
  const updatedClips = replaceAt(track.clips, clipIndex, updatedClip);
  const updatedTrack: Track = { ...track, clips: updatedClips };
  const updatedTracks = replaceAt(composition.tracks, trackIndex, updatedTrack);
  const updatedComposition: Composition = { ...composition, tracks: updatedTracks };
  const updatedCompositions = replaceAt(project.compositions, compositionIndex, updatedComposition);

  return { ...project, compositions: updatedCompositions };
}

/** Returns a new array equal to `items` except index `index` is replaced with `replacement`. */
function replaceAt<T>(items: readonly T[], index: number, replacement: T): T[] {
  const next = items.slice();
  next[index] = replacement;
  return next;
}

/**
 * Shallow-merges `fields` onto `node`, keeping `id`, `kind`, and `children`
 * exactly as they were on the original node (the `updateNode` patch
 * operation's schema already forbids those three keys in `fields`, but this
 * function re-asserts it structurally rather than trusting that check alone
 * to have run first). Any other field present in `fields` replaces that
 * field's current value outright; every field absent from `fields` is left
 * untouched.
 *
 * The merged result is deliberately returned as `SceneNode`, not re-validated
 * here: the caller (`applyScenePatchOperations`) always runs the whole
 * patched project through `parseScene` before it is ever persisted, so an
 * invalid merge (e.g. a `mesh`-only field spliced onto a `text` node) is
 * still caught, just one step later, with the same diagnostics quality as
 * every other validation failure in this phase.
 */
function mergeNodeFields(node: SceneNode, fields: Record<string, unknown>): SceneNode {
  return {
    ...node,
    ...fields,
    id: node.id,
    kind: node.kind,
    children: node.children,
  } as SceneNode;
}

/**
 * Applies one {@link ScenePatchOperation} to `project`, returning the new
 * `Project`. Delegates to `@cadra/core`'s `addNode`/`updateNode`/`removeNode`
 * for the actual subtree edit, after locating (via
 * {@link applyNodeOperationToProject}) which clip's node tree the operation's
 * anchor id lives in.
 *
 * Does not itself validate the result against the schema; see
 * `applyScenePatchOperations`, which runs every operation in sequence and
 * leaves schema validation to its caller (`update_scene`'s tool handler),
 * exactly once, against the final patched document.
 *
 * @throws {PatchNodeNotFoundError} if the operation's anchor id (the parent
 *   for `addNode`, the target for `updateNode`/`removeNode`) is not found in
 *   any clip's node tree.
 * @throws {DuplicateNodeIdError} if an `addNode` operation's new node id
 *   already exists somewhere in the project.
 */
export function applyScenePatchOperation(
  project: Project,
  operation: ScenePatchOperation,
): Project {
  switch (operation.type) {
    case "addNode": {
      if (projectContainsNodeId(project, operation.node.id)) {
        throw new DuplicateNodeIdError(operation.node.id);
      }
      return applyNodeOperationToProject(project, operation.parentId, (clipRoot) =>
        addNode(clipRoot, operation.parentId, operation.node),
      );
    }

    case "updateNode": {
      return applyNodeOperationToProject(project, operation.nodeId, (clipRoot) =>
        updateNode(clipRoot, operation.nodeId, (node) => mergeNodeFields(node, operation.fields)),
      );
    }

    case "removeNode": {
      return applyNodeOperationToProject(project, operation.nodeId, (clipRoot) =>
        removeNode(clipRoot, operation.nodeId),
      );
    }
  }
}

/**
 * Applies a whole sequence of {@link ScenePatchOperation}s to `project`, in
 * order, each building on the previous operation's result (so a later
 * operation in the same call can reference a node id added by an earlier one
 * in that same call).
 */
export function applyScenePatchOperations(
  project: Project,
  operations: readonly ScenePatchOperation[],
): Project {
  let current = project;
  for (const operation of operations) {
    current = applyScenePatchOperation(current, operation);
  }
  return current;
}
