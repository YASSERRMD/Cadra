import type { Property } from "../keyframes/keyframe-track.js";
import {
  type AnimatableTransform,
  type ColorRGBA,
  createIdentityTransform,
} from "../scene-graph/primitives.js";
import type { TextNode } from "../scene-graph/scene-node.js";

/**
 * Props for `Text`. Only `id` is required; everything else defaults.
 *
 * `transform`, `visible`, `fontSize`, and `color` each accept either a plain
 * value or a `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain
 * value, as every existing caller does, keeps working unchanged.
 */
export interface TextProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: TextNode["children"];
  content?: string;
  fontRef?: string;
  fontSize?: Property<number>;
  color?: Property<ColorRGBA>;
}

/**
 * Creates a `TextNode`: a block of rendered text.
 *
 * Defaults: identity transform, `visible: true`, no children, empty
 * `content`, `fontSize: 24`, opaque white `color`. `fontRef` is left
 * `undefined` unless supplied, matching `TextNode`'s "omitted means the
 * renderer's default" convention.
 */
export function Text(props: TextProps): TextNode {
  return {
    id: props.id,
    kind: "text",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    content: props.content ?? "",
    ...(props.fontRef !== undefined && { fontRef: props.fontRef }),
    fontSize: props.fontSize ?? 24,
    color: props.color ?? [1, 1, 1, 1],
  };
}
