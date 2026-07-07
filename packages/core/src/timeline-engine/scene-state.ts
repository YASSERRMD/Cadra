import type { SceneNode } from "../scene-graph/scene-node.js";
import type { CompositionColorGrading } from "../scene-graph/timeline.js";

/**
 * One resolved, positioned piece of content contributed by a single `Clip` at
 * a specific frame.
 *
 * `node` is the clip's scene-node subtree unchanged (the timeline engine
 * resolves visibility and z-order, not per-node transforms; interpolating
 * animatable properties on `node` using `localFrame` is Phase 9/10's job).
 * `trackId`/`clipId` name exactly which track and clip produced this layer,
 * and `compositionId` names which composition (the outer one, or a nested
 * one spliced in via a `compositionRef`) owns that track, so a layer stays
 * traceable back to its source even after nested compositions are flattened
 * into the parent's layer list.
 */
export interface ResolvedLayer {
  /** Id of the composition (outer or nested) whose track produced this layer. */
  compositionId: string;
  trackId: string;
  clipId: string;
  /** The clip's root scene node, unchanged. */
  node: SceneNode;
  /**
   * Stacking order relative to the other layers in the same `SceneState`:
   * always equal to this layer's index in `SceneState.layers`. Kept as an
   * explicit field (rather than making callers rely on array position) so a
   * layer is still self-describing if it is ever copied out of its array.
   */
  zIndex: number;
  /**
   * Frame local to the `Clip` that produced this layer (`0` on the clip's
   * first visible frame), exactly as computed by `resolveSequenceFrame`. This
   * is the frame Phase 9/10's interpolation evaluates animatable properties
   * at, and the frame a nested composition's own resolution used internally.
   */
  localFrame: number;
  /**
   * Blend/opacity this layer should render at, in `[0, 1]`. Defaults to `1`
   * for a layer with no active transition. When the layer's clip has a
   * `transitionIn` overlapping the current frame, this is the incoming
   * clip's blend factor (see `resolveTransitionBlend`); when this layer was
   * emitted as the outgoing half of a preceding clip's overlap, it is
   * `1 - blend` instead. Purely numeric metadata: actually compositing two
   * layers at less-than-full opacity (a real fade/wipe/cross-dissolve
   * shader) is a future renderer concern, not the timeline engine's.
   */
  opacity: number;
}

/**
 * The fully resolved, flat, render-ready state of one composition at one
 * frame.
 *
 * `layers` is a flat list in resolved stacking order: index `0` is furthest
 * back, and each later element renders on top of every earlier one. This is
 * the one z-order convention the whole engine uses, so nothing downstream
 * (renderer, player) needs its own notion of layer ordering. Nested
 * compositions do not get their own nested `SceneState` in the result:
 * their resolved layers are spliced directly into this flat list at the
 * position their `compositionRef` occupied, so a `SceneState` never contains
 * another `SceneState`.
 */
export interface SceneState {
  /** Id of the composition this state resolves, i.e. the `resolveSceneAtFrame` call's own `compositionId` argument (never a nested one). */
  compositionId: string;
  /** The global frame this state was resolved at. */
  frame: number;
  width: number;
  height: number;
  layers: ResolvedLayer[];
  /**
   * Id of the `CameraNode` active at `frame`, per the composition's own
   * `activeCameraTrack` (see `Composition.activeCameraTrack`). `undefined`
   * when the composition has no `activeCameraTrack` at all, or when none of
   * its entries cover `frame`: deciding which camera to actually render with
   * in that case is left to a later phase (Phase 13's player runtime), not
   * modeled as an error here.
   */
  activeCameraNodeId?: string;
  /** This composition's own `Composition.colorGrading`, unchanged. `undefined` when the composition has none, i.e. a neutral grade. */
  colorGrading?: CompositionColorGrading;
}
