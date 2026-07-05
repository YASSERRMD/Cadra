import { createIdentityTransform } from "../scene-graph/primitives.js";
import type { SceneNode } from "../scene-graph/scene-node.js";
import type { Clip } from "../scene-graph/timeline.js";

/**
 * Props for `Sequence`. `id` is the id of the produced `Clip`. `from` and
 * `durationInFrames` must both be integers: they are frame counts, never
 * wall-clock time.
 *
 * `content` is either a single `SceneNode` (used as the clip's root node
 * directly) or multiple sibling nodes, which get wrapped in a `group` node so
 * the clip still has exactly one root. The wrapper's id is derived
 * deterministically from `id` (see `deriveSequenceRootId`), never generated
 * by a hidden counter.
 */
export interface SequenceProps {
  id: string;
  from: number;
  durationInFrames: number;
  content: SceneNode | SceneNode[];
}

/**
 * Deterministically derives the id of the wrapper `group` node `Sequence`
 * creates when `content` is more than one sibling node. Pure string
 * transform of the clip id: same `clipId` in always produces the same
 * wrapper id out, so a caller never needs to pass a second id just to get a
 * multi-child `Sequence`.
 */
export function deriveSequenceRootId(clipId: string): string {
  return `${clipId}-root`;
}

/**
 * Creates a `Clip` that places `content` on the timeline starting at frame
 * `from` for `durationInFrames` frames.
 *
 * Single-node `content` becomes the clip's `node` unchanged. Multi-node
 * `content` is wrapped in a `group` node (id from `deriveSequenceRootId`,
 * identity transform, `visible: true`) so the clip always has exactly one
 * root, matching `Clip.node`'s single-`SceneNode` shape.
 */
export function Sequence(props: SequenceProps): Clip {
  const node: SceneNode = Array.isArray(props.content)
    ? {
        id: deriveSequenceRootId(props.id),
        kind: "group",
        transform: createIdentityTransform(),
        visible: true,
        children: props.content,
      }
    : props.content;

  return {
    id: props.id,
    startFrame: props.from,
    durationInFrames: props.durationInFrames,
    node,
  };
}

/** Input to `resolveSequenceFrame`: the two `Clip` fields that define its window on a timeline. */
export interface SequenceWindow {
  startFrame: number;
  durationInFrames: number;
}

/** Output of `resolveSequenceFrame`: whether a sequence is showing, and its child-local frame. */
export interface SequenceFrameResolution {
  visible: boolean;
  localFrame: number;
}

/**
 * Remaps a parent-timeline frame index to a sequence's local frame index.
 *
 * `visible` is true exactly when `parentFrame` falls in the half-open
 * interval `[startFrame, startFrame + durationInFrames)`: `startFrame`
 * itself is the first visible frame, `startFrame + durationInFrames` is the
 * first frame after the sequence ends, not the last visible one.
 *
 * `localFrame` is `parentFrame - startFrame` unconditionally, including when
 * `visible` is false: callers that only care about the visible case can
 * ignore it, but it stays a well-defined, continuous function of
 * `parentFrame` rather than being clamped or undefined outside the window.
 *
 * Pure and standalone so Phase 8's timeline engine can call it directly
 * without constructing a `Sequence` or a `Clip`.
 */
export function resolveSequenceFrame(
  sequence: SequenceWindow,
  parentFrame: number,
): SequenceFrameResolution {
  const localFrame = parentFrame - sequence.startFrame;
  const visible = localFrame >= 0 && localFrame < sequence.durationInFrames;
  return { visible, localFrame };
}
