import type {
  CameraNode,
  Clip,
  ColorRGBA,
  LightNode,
  SceneNode,
  TextNode,
  Transition,
  Vector3,
} from "@cadra/core";

import { SceneBuilderUsageError } from "./errors.js";
import { type AnimateInput, toKeyframeTrack } from "./keyframe-input.js";

/**
 * The shared `transform` fields every `SceneNode` carries, each independently
 * animatable via `.animateTransform()`. Mirrors `AnimatableTransform` in
 * `@cadra/core`.
 */
export interface TransformAnimationPatch {
  position?: AnimateInput<Vector3>;
  rotation?: AnimateInput<Vector3>;
  scale?: AnimateInput<Vector3>;
}

/**
 * Maps a `SceneNode` variant to the extra (non-`transform`, non-`visible`)
 * fields `.animate()` accepts for it, restricted to exactly the fields that
 * are genuinely `Property<T>`-typed on that node kind (see `@cadra/core`'s
 * `primitives/animatable-properties.ts` for the same list, expressed there as
 * dot-paths rather than a mapped type).
 *
 * `group`, `mesh`, `image`, and `compositionRef` nodes have no extra
 * animatable fields beyond `transform`/`visible` (both handled by
 * `animateTransform`/`animateVisible` instead), so their patch type is empty.
 */
export type AnimationPatchFor<TNode extends SceneNode> = TNode extends CameraNode
  ? {
      fov?: AnimateInput<number>;
      near?: AnimateInput<number>;
      far?: AnimateInput<number>;
      target?: AnimateInput<Vector3>;
    }
  : TNode extends LightNode
    ? { color?: AnimateInput<ColorRGBA>; intensity?: AnimateInput<number> }
    : TNode extends TextNode
      ? { color?: AnimateInput<ColorRGBA>; fontSize?: AnimateInput<number> }
      : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
        {};

/** `visible` is `Property<boolean>` on every node kind alike, so its input needs no per-kind branching. */
export type VisibleAnimationInput = AnimateInput<boolean>;

/** Options `.at()` accepts beyond the required `startFrame`/`durationInFrames`. */
export interface AtOptions {
  /**
   * The id of the produced `Clip`. Defaults to the node's own `id` with a
   * `"-clip"` suffix, kept distinct from the node's id by default since a
   * `Track`'s clips and a composition's scene nodes are different id spaces
   * that may otherwise collide (e.g. placing the same node on two different
   * tracks would otherwise produce two clips sharing one id).
   */
  clipId?: string;
  /** Optional transition this clip blends in with. Omitted means an instant cut. */
  transitionIn?: Transition;
}

/**
 * A `SceneNode` placed on the timeline: the exact `Clip` shape
 * `CompositionBuilder.add()` accepts, produced by `NodeBuilder.at()`.
 */
export interface ClipPlacement {
  clip: Clip;
}

/**
 * A fluent wrapper around a single `SceneNode`, returned by every builder
 * primitive (`Text`, `Image`, `Shape`, `Camera`, `Light`). Lets a caller
 * animate the node's `Property<T>` fields and then place it on the timeline
 * via `.at()`, without hand-assembling a `Clip`.
 *
 * Every `.animate*()` call returns `this` (replacing the wrapped node with an
 * updated copy) so calls chain:
 * `Text({...}).animateTransform({...}).animate({...}).at(0, 30)`.
 */
export class NodeBuilder<TNode extends SceneNode> {
  private current: TNode;

  constructor(node: TNode) {
    this.current = node;
  }

  /** The current, possibly-animated `SceneNode` this builder wraps. */
  get node(): TNode {
    return this.current;
  }

  /**
   * Sets one or more of this node's shared `transform` fields
   * (`position`/`rotation`/`scale`) to a keyframe track. Fields omitted from
   * `patch` are left exactly as they were (still a plain constant, or a
   * previously-set track from an earlier `.animateTransform()` call).
   */
  animateTransform(patch: TransformAnimationPatch): this {
    const transform = { ...this.current.transform };
    if (patch.position !== undefined) {
      transform.position = toKeyframeTrack(patch.position);
    }
    if (patch.rotation !== undefined) {
      transform.rotation = toKeyframeTrack(patch.rotation);
    }
    if (patch.scale !== undefined) {
      transform.scale = toKeyframeTrack(patch.scale);
    }
    this.current = { ...this.current, transform };
    return this;
  }

  /**
   * Sets this node's `visible` field to a keyframe track. `visible` is
   * `Property<boolean>` on every node kind alike (see `resolveBooleanProperty`
   * in `@cadra/core`), so this method needs no per-kind restriction the way
   * `.animate()` does.
   *
   * A boolean keyframe track has no meaningful continuous blend: author each
   * keyframe (except the last) with `easing: 'hold'` so the value steps
   * discretely at the next keyframe's frame, rather than passing through a
   * curve with no defined in-between for a boolean.
   */
  animateVisible(input: VisibleAnimationInput): this {
    this.current = { ...this.current, visible: toKeyframeTrack(input) };
    return this;
  }

  /**
   * Sets one or more of this node kind's extra animatable fields (beyond
   * `transform`/`visible`) to a keyframe track: `camera`'s
   * `fov`/`near`/`far`/`target`, `light`'s `color`/`intensity`, or `text`'s
   * `color`/`fontSize`. Restricted at the type level to exactly the fields
   * `AnimationPatchFor<TNode>` lists for this node's own kind, so animating a
   * field that kind does not actually support (e.g. `fontSize` on a `Shape`)
   * is a compile error rather than a silently-ignored call.
   */
  animate(patch: AnimationPatchFor<TNode>): this {
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        updates[key] = toKeyframeTrack(value as AnimateInput<unknown>);
      }
    }
    this.current = { ...this.current, ...updates };
    return this;
  }

  /**
   * Places this node on the timeline as a `Clip` starting at `startFrame` for
   * `durationInFrames` frames, ready to hand to `CompositionBuilder.add()`.
   *
   * Throws `SceneBuilderUsageError` for a structurally impossible frame range
   * (a negative or non-integer `startFrame`, or a non-positive or non-integer
   * `durationInFrames`) immediately at the call site, rather than letting an
   * obviously-invalid `Clip` propagate into the assembled document and only
   * surface as a `SceneBuildError` out of `.build()`. This mirrors, but does
   * not replace, `@cadra/schema`'s own `clipSchema` validation: `.build()`
   * still re-validates the whole document.
   */
  at(startFrame: number, durationInFrames: number, options: AtOptions = {}): ClipPlacement {
    if (!Number.isInteger(startFrame) || startFrame < 0) {
      throw new SceneBuilderUsageError(
        `.at(startFrame, durationInFrames): startFrame must be a non-negative integer, got ${startFrame}.`,
      );
    }
    if (!Number.isInteger(durationInFrames) || durationInFrames <= 0) {
      throw new SceneBuilderUsageError(
        `.at(startFrame, durationInFrames): durationInFrames must be a positive integer, got ${durationInFrames}.`,
      );
    }

    const clip: Clip = {
      id: options.clipId ?? `${this.current.id}-clip`,
      startFrame,
      durationInFrames,
      node: this.current,
      ...(options.transitionIn !== undefined && { transitionIn: options.transitionIn }),
    };

    return { clip };
  }
}
