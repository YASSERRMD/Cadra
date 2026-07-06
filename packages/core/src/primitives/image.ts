import type { Property } from "../keyframes/keyframe-track.js";
import { type AnimatableTransform, createIdentityTransform } from "../scene-graph/primitives.js";
import type { ImageNode } from "../scene-graph/scene-node.js";

/**
 * Props for `Image`. Only `id` is required; everything else defaults.
 *
 * `transform` and `visible` each accept either a plain value or a
 * `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain value, as every
 * existing caller does, keeps working unchanged.
 */
export interface ImageProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: ImageNode["children"];
  assetRef?: string;
}

/**
 * Creates an `ImageNode`: a 2D image plane.
 *
 * Defaults: identity transform, `visible: true`, no children,
 * `assetRef: "default"`.
 */
export function Image(props: ImageProps): ImageNode {
  return {
    id: props.id,
    kind: "image",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    assetRef: props.assetRef ?? "default",
  };
}
