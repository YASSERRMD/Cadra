import { resolveSequenceFrame } from "../primitives/sequence.js";
import type { CompositionRefNode, SceneNode } from "../scene-graph/scene-node.js";
import type {
  ActiveCameraEntry,
  Clip,
  Composition,
  Project,
  Track,
} from "../scene-graph/timeline.js";
import { CompositionCycleError, CompositionNotFoundError } from "./errors.js";
import type { ResolvedLayer, SceneState } from "./scene-state.js";
import { resolveTransitionBlend } from "./transition.js";

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

  const activeCameraNodeId = resolveActiveCameraNodeId(composition.activeCameraTrack, frame);

  return {
    compositionId: composition.id,
    frame,
    width: composition.width,
    height: composition.height,
    layers: pending.map((layer, index) => ({ ...layer, zIndex: index })),
    ...(activeCameraNodeId !== undefined && { activeCameraNodeId }),
    ...(composition.colorGrading !== undefined && { colorGrading: composition.colorGrading }),
    ...(composition.environment !== undefined && { environment: composition.environment }),
    ...(composition.fog !== undefined && { fog: composition.fog }),
    ...(composition.shadowQuality !== undefined && { shadowQuality: composition.shadowQuality }),
    ...(composition.postProcessing !== undefined && { postProcessing: composition.postProcessing }),
    ...(composition.renderMode !== undefined && { renderMode: composition.renderMode }),
    ...(composition.pathTracing !== undefined && { pathTracing: composition.pathTracing }),
    ...(composition.physics !== undefined && { physics: composition.physics }),
    ...(composition.physicsConstraints !== undefined && {
      physicsConstraints: composition.physicsConstraints,
    }),
  };
}

/**
 * Finds which `ActiveCameraEntry` in `activeCameraTrack` (if any) covers
 * `frame`, reusing `resolveSequenceFrame`'s visibility math: an
 * `ActiveCameraEntry` has the same `startFrame`/`durationInFrames`
 * half-open-window shape as a `Clip`, so the same "is `frame` inside
 * `[startFrame, startFrame + durationInFrames)`" rule applies unchanged.
 *
 * Returns `undefined` when `activeCameraTrack` is absent or empty, or when no
 * entry covers `frame` (e.g. a gap between two entries): this is a normal,
 * unexceptional outcome, not an error, so a composition authored without an
 * active-camera concept at all keeps resolving exactly as before.
 */
function resolveActiveCameraNodeId(
  activeCameraTrack: readonly ActiveCameraEntry[] | undefined,
  frame: number,
): string | undefined {
  if (activeCameraTrack === undefined) {
    return undefined;
  }
  const covering = activeCameraTrack.find((entry) => resolveSequenceFrame(entry, frame).visible);
  return covering?.cameraNodeId;
}

/**
 * True when `clip.transitionIn` is currently overlapping `frame`, i.e.
 * `frame` falls in the half-open window `[clip.startFrame, clip.startFrame +
 * transitionIn.durationInFrames)`. `framesIntoTransition` (`frame -
 * clip.startFrame`) doubles as the clip's own `localFrame` while its
 * transition is active, since both count frames from the same origin.
 */
function activeTransitionAt(
  clip: Clip,
  frame: number,
): { transitionIn: NonNullable<Clip["transitionIn"]>; framesIntoTransition: number } | undefined {
  const { transitionIn } = clip;
  if (transitionIn === undefined) {
    return undefined;
  }
  const framesIntoTransition = frame - clip.startFrame;
  if (framesIntoTransition < 0 || framesIntoTransition >= transitionIn.durationInFrames) {
    return undefined;
  }
  return { transitionIn, framesIntoTransition };
}

/**
 * Appends every layer `track`'s clips contribute at `frame`, in track/clip
 * order, to `pending`.
 *
 * Iterates by index so a clip whose `transitionIn` is currently active can
 * look back at `track.clips[index - 1]` (the clip immediately preceding it
 * in authoring order): when that is the case, this function emits the
 * preceding clip's content first (opacity `1 - blend`, extending its
 * visibility past its own natural end for the overlap) followed by the
 * current clip's content (opacity `blend`). The preceding clip's own turn in
 * the loop later checks whether its *next* clip has an active transition
 * right now and, if so, skips its normal-visibility branch, so it is never
 * emitted a second time.
 */
function resolveTrack(
  project: Project,
  composition: Composition,
  track: Track,
  frame: number,
  chain: readonly string[],
  pending: PendingLayer[],
): void {
  const { clips } = track;

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    if (clip === undefined) {
      continue;
    }

    const active = activeTransitionAt(clip, frame);
    if (active !== undefined) {
      const blend = resolveTransitionBlend(active.transitionIn, active.framesIntoTransition);
      const previousClip = clips[index - 1];
      if (previousClip !== undefined) {
        const previousLocalFrame = frame - previousClip.startFrame;
        resolveClipContent(
          project,
          composition,
          track,
          previousClip,
          previousClip.node,
          previousLocalFrame,
          1 - blend,
          chain,
          pending,
        );
      }
      resolveClipContent(
        project,
        composition,
        track,
        clip,
        clip.node,
        active.framesIntoTransition,
        blend,
        chain,
        pending,
      );
      continue;
    }

    // Not currently the incoming half of an active transition. Skip this
    // clip's own normal-visibility branch if the *next* clip's transitionIn
    // is active right now: that next clip's own branch above already emitted
    // this clip (as the outgoing half, at 1 - blend), so emitting it again
    // here via its ordinary visibility window would double it up. This only
    // matters when authored clips overlap in their raw start/duration
    // windows; the common back-to-back case never reaches this branch for
    // the outgoing clip, since its own natural visibility has already ended
    // by the time the next clip's transition window opens.
    const nextClip = clips[index + 1];
    if (nextClip !== undefined && activeTransitionAt(nextClip, frame) !== undefined) {
      continue;
    }

    const { visible, localFrame } = resolveSequenceFrame(clip, frame);
    if (!visible) {
      continue;
    }
    resolveClipContent(project, composition, track, clip, clip.node, localFrame, 1, chain, pending);
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
 *
 * `opacity` is stamped onto every layer this call (and its recursive splices)
 * produces: a nested composition spliced in via `compositionRef` inherits the
 * enclosing clip's transition opacity uniformly across all of its own
 * resolved layers, rather than each nested layer defaulting back to `1`.
 *
 * Each nested layer's own `node` is individually wrapped in a synthetic
 * `group` node carrying the `compositionRef`'s own `transform`/`visible`
 * (`wrapCompositionRefTransform`) rather than being spliced in unchanged:
 * `CompositionRefNode`, like every `SceneNode`, has its own real
 * `transform`, but with no wrapper it was silently discarded entirely - a
 * `compositionRef` could never actually be moved/scaled/rotated relative to
 * where it sits in the parent composition. Wrapping is safe precisely
 * because it does *not* try to compose two `AnimatableTransform`s
 * symbolically (each may independently be keyframed, and this resolution
 * pass deliberately never evaluates keyframes - see this module's own doc):
 * the reconciler already resolves every node in a `SceneState`'s entire
 * flattened tree against the same single global frame regardless of
 * nesting depth or which original clip a node came from (confirmed
 * directly: `ResolvedLayer.localFrame` has exactly one downstream reader,
 * `worker/scene-state-diff.ts`'s own dirty-check, never transform
 * evaluation), so an ordinary parent-child `THREE.Object3D` hierarchy -
 * exactly what a `group` node with children already produces, with zero
 * renderer changes needed - composes the two transforms correctly every
 * frame, keyframes included, the same way it already does for any other
 * `group` wrapping animated children.
 */
function resolveClipContent(
  project: Project,
  composition: Composition,
  track: Track,
  clip: Clip,
  node: SceneNode,
  localFrame: number,
  opacity: number,
  chain: readonly string[],
  pending: PendingLayer[],
): void {
  if (node.kind === "compositionRef") {
    const nested = resolveComposition(project, node.compositionId, localFrame, chain);
    pending.push(
      ...nested.layers.map((layer) => ({
        ...layer,
        node: wrapCompositionRefTransform(node, layer.node),
        opacity,
      })),
    );
    return;
  }

  if (!containsCompositionRef(node)) {
    pending.push({
      compositionId: composition.id,
      trackId: track.id,
      clipId: clip.id,
      node,
      localFrame,
      opacity,
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
      resolveClipContent(
        project,
        composition,
        track,
        clip,
        child,
        localFrame,
        opacity,
        chain,
        pending,
      );
    }
  }

  pending.push({
    compositionId: composition.id,
    trackId: track.id,
    clipId: clip.id,
    node: pruneCompositionRefs(node),
    localFrame,
    opacity,
  });
}

/**
 * Wraps `nestedRootNode` (one nested layer's own root node, still in the
 * nested composition's own local coordinate space) in a synthetic `group`
 * node carrying `compositionRefNode`'s own `transform`/`visible` - see
 * `resolveClipContent`'s own doc for why an ordinary parent-child wrapper
 * is exactly the right mechanism here, with zero renderer changes needed.
 *
 * The wrapper's own `id` is derived from both the `compositionRef`'s own id
 * and the wrapped node's own id: a single `compositionRef` splices in one
 * wrapper per nested layer (not one shared wrapper for the whole nested
 * composition, matching `resolveClipContent`'s own "one `ResolvedLayer` per
 * nested layer" splicing, which preserves each nested layer's own z-order/
 * provenance), and the reconciler identifies sibling nodes by id within one
 * `reconcile()` call - reusing `compositionRefNode.id` alone across every
 * nested layer's own wrapper would collide.
 */
function wrapCompositionRefTransform(compositionRefNode: CompositionRefNode, nestedRootNode: SceneNode): SceneNode {
  return {
    id: `${compositionRefNode.id}:wraps:${nestedRootNode.id}`,
    kind: "group",
    transform: compositionRefNode.transform,
    visible: compositionRefNode.visible,
    children: [nestedRootNode],
  };
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
