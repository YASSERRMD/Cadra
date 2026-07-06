import type { Property } from "../keyframes/keyframe-track.js";
import {
  type AnimatableTransform,
  type ColorRGBA,
  createIdentityTransform,
} from "../scene-graph/primitives.js";
import type { LightNode, LightType } from "../scene-graph/scene-node.js";

/**
 * Props for `Light`. Only `id` is required; everything else defaults.
 *
 * `transform`, `visible`, `color`, and `intensity` each accept either a plain
 * value or a `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain
 * value, as every existing caller does, keeps working unchanged.
 */
export interface LightProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: LightNode["children"];
  lightType?: LightType;
  color?: Property<ColorRGBA>;
  intensity?: Property<number>;
}

/**
 * Creates a `LightNode`.
 *
 * Defaults: identity transform, `visible: true`, no children,
 * `lightType: "directional"`, opaque white `color`, `intensity: 1`.
 */
export function Light(props: LightProps): LightNode {
  return {
    id: props.id,
    kind: "light",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    lightType: props.lightType ?? "directional",
    color: props.color ?? [1, 1, 1, 1],
    intensity: props.intensity ?? 1,
  };
}
