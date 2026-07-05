import { resolveSequenceFrame } from "../primitives/sequence.js";
import type { SceneNode } from "../scene-graph/scene-node.js";
import type { Clip, Composition, Project, Track } from "../scene-graph/timeline.js";
import { CompositionCycleError, CompositionNotFoundError } from "./errors.js";
import type { ResolvedLayer, SceneState } from "./scene-state.js";

/**
 * Per-`Project` memoization cache. Keyed by object reference (`WeakMap`) so a
 * different `Project` object, even a deep-equal one, is simply a cache miss:
 * safe by construction, never stale, and never leaks since entries disappear
 * once their `Project` is garbage collected. The inner `Map` is keyed by
 * `` `${compositionId}:${frame}` `` because one `Project` has many
 * compositions and each composition has many resolvable frames.
 */
const resolutionCache = new WeakMap<Project, Map<string, SceneState>>();

function cacheKey(compositionId: string, frame: number): string {
  return `${compositionId}:${frame}`;
}

function findComposition(project: Project, compositionId: string): Composition | undefined {
  return project.compositions.find((composition) => composition.id === compositionId);
}

/**
 * Resolves `project`'s composition `compositionId` at `frame` into a flat,
 * ordered `SceneState`.
 *
 * Pure and deterministic: identical `(project, compositionId, frame)` always
 * produce a deep-equal result, and nothing here reads a wall clock or draws
 * unseeded randomness. Takes a plain frame number rather than a `FrameContext`
 * because nothing this phase does (visibility, local-frame remapping,
 * z-ordering) needs a seed or a derived `time`; interpolating animatable
 * properties per resolved layer, which will need those, is Phase 9/10's job.
 *
 * Results are memoized per exact `Project` object reference (see
 * `resolutionCache`): calling this twice with the same `project` reference
 * and `frame` returns the cached `SceneState` instead of recomputing it, and
 * a structurally-identical but distinct `Project` object is always a clean
 * cache miss rather than risking stale or cross-project-shared results.
 *
 * @throws {CompositionNotFoundError} if `compositionId` (or any composition
 *   referenced transitively via a `compositionRef`) does not exist in `project`.
 * @throws {CompositionCycleError} if resolving `compositionId` would recurse
 *   into a composition already being resolved higher up the same call chain.
 */
export function resolveSceneAtFrame(
  project: Project,
  compositionId: string,
  frame: number,
): SceneState {
  let projectCache = resolutionCache.get(project);
  if (projectCache === undefined) {
    projectCache = new Map();
    resolutionCache.set(project, projectCache);
  }

  const key = cacheKey(compositionId, frame);
  const cached = projectCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const state = resolveComposition(project, compositionId, frame, []);
  projectCache.set(key, state);
  return state;
}

/** A resolved layer before its final stacking position is known; `zIndex` is assigned once, in `resolveComposition`. */
type PendingLayer = Omit<ResolvedLayer, "zIndex">;

/**
 * Internal recursive resolver. `chain` lists the ids of compositions
 * currently being resolved higher up this call stack (outermost first), used
 * only for cycle detection: it is never cached or exposed, since it is a
 * property of one call chain, not of the `(compositionId, frame)` pair.
 */
function resolveComposition(
  project: Project,
  compositionId: string,
  frame: number,
  chain: readonly string[],
): SceneState {
  if (chain.includes(compositionId)) {
    throw new CompositionCycleError([...chain, compositionId]);
  }

  const composition = findComposition(project, compositionId);
  if (composition === undefined) {
    throw new CompositionNotFoundError(compositionId);
  }

  const nextChain = [...chain, compositionId];
  const pending: PendingLayer[] = [];

  for (const track of composition.tracks) {
    resolveTrack(project, composition, track, frame, nextChain, pending);
  }

  return {
    compositionId: composition.id,
    frame,
    width: composition.width,
    height: composition.height,
    layers: pending.map((layer, index) => ({ ...layer, zIndex: index })),
  };
}

/** Appends every layer `track`'s clips contribute at `frame`, in track/clip order, to `pending`. */
function resolveTrack(
  project: Project,
  composition: Composition,
  track: Track,
  frame: number,
  chain: readonly string[],
  pending: PendingLayer[],
): void {
  for (const clip of track.clips) {
    const { visible, localFrame } = resolveSequenceFrame(clip, frame);
    if (!visible) {
      continue;
    }
    resolveClipContent(project, composition, track, clip, clip.node, localFrame, chain, pending);
  }
}

/**
 * Walks one clip's node subtree, splicing in a layer for every
 * `compositionRef` found (recursively resolved at `localFrame`, the frame
 * local to the enclosing `Clip`: plain `group` nodes never remap time, only
 * `Clip`s do), plus exactly one more layer for `node` itself with every
 * `compositionRef` descendant pruned out (a plain childless node is
 * unaffected by pruning; a `compositionRef` root is handled entirely by the
 * first branch below and contributes no such layer of its own).
 *
 * Ordinary content is only ever emitted once per clip: this matches how the
 * Phase 6 reconciler already treats a `compositionRef` it encounters
 * directly, so a resolved layer's node tree never contains a `compositionRef`
 * a downstream renderer would have to special-case.
 */
function resolveClipContent(
  project: Project,
  composition: Composition,
  track: Track,
  clip: Clip,
  node: SceneNode,
  localFrame: number,
  chain: readonly string[],
  pending: PendingLayer[],
): void {
  if (node.kind === "compositionRef") {
    const nested = resolveComposition(project, node.compositionId, localFrame, chain);
    pending.push(...nested.layers);
    return;
  }

  if (!containsCompositionRef(node)) {
    pending.push({
      compositionId: composition.id,
      trackId: track.id,
      clipId: clip.id,
      node,
      localFrame,
    });
    return;
  }

  // A descendant (not this node) is a compositionRef. Only recurse into
  // children that themselves contain one, splicing each in document order:
  // a child with no compositionRef anywhere in it is ordinary content that
  // the pruned copy below already preserves in place, so recursing into it
  // too would emit it as a second, duplicate layer.
  for (const child of node.children) {
    if (containsCompositionRef(child)) {
      resolveClipContent(project, composition, track, clip, child, localFrame, chain, pending);
    }
  }

  pending.push({
    compositionId: composition.id,
    trackId: track.id,
    clipId: clip.id,
    node: pruneCompositionRefs(node),
    localFrame,
  });
}

/** True if `node` itself or any descendant is a `compositionRef` node. */
function containsCompositionRef(node: SceneNode): boolean {
  if (node.kind === "compositionRef") {
    return true;
  }
  return node.children.some(containsCompositionRef);
}

/**
 * Returns a copy of `node` with every `compositionRef` descendant removed
 * from the tree (its content already became its own separate layer via
 * `resolveClipContent`, so leaving it in place would render it twice).
 *
 * Callers only reach this once they already know `node` itself is not a
 * `compositionRef` (that case is handled directly in `resolveClipContent`).
 * A pure structural copy: never mutates `node`, and returns `node` itself
 * (same reference) when nothing needed pruning, so unrelated sibling
 * subtrees keep structural sharing with the original clip content. A node
 * left with zero children after pruning still renders as an empty, harmless
 * container (matching the reconciler's own compositionRef -> empty Group
 * behavior), so it is always kept rather than dropped.
 */
function pruneCompositionRefs(node: SceneNode): SceneNode {
  if (node.children.length === 0) {
    return node;
  }

  const prunedChildren: SceneNode[] = [];
  let changed = false;
  for (const child of node.children) {
    if (child.kind === "compositionRef") {
      changed = true;
      continue;
    }
    const prunedChild = pruneCompositionRefs(child);
    if (prunedChild !== child) {
      changed = true;
    }
    prunedChildren.push(prunedChild);
  }

  return changed ? { ...node, children: prunedChildren } : node;
}
