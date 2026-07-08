import type { Property } from "../keyframes/keyframe-track.js";
import { type AnimatableTransform, type ColorRGBA, createIdentityTransform } from "../scene-graph/primitives.js";
import type { VolumeNode, VolumeShape } from "../scene-graph/scene-node.js";

/**
 * Props for `Volume`. Only `id` is required; every other field defaults to
 * a small, visible-out-of-the-box configuration (see `Volume`'s own doc for
 * the exact defaults), the same zero-config philosophy `Shape`'s own
 * `"box"`/`"default"` placeholders establish.
 *
 * `transform`, `visible`, `color`, and `density` each accept either a plain
 * value or a `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain
 * value, as every existing caller of every other primitive does, keeps
 * working unchanged.
 */
export interface VolumeProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: VolumeNode["children"];
  shape?: VolumeShape;
  color?: Property<ColorRGBA>;
  density?: Property<number>;
  noiseFrequency?: number;
  driftSpeed?: number;
  raymarchSteps?: number;
  seed?: number;
}

/**
 * Creates a `VolumeNode`: a simple animated volumetric smoke/mist volume
 * (Phase 68).
 *
 * Defaults: identity transform, `visible: true`, no children, a
 * `{type: "sphere", radius: 1}` bounding shape, a neutral light gray
 * `color`, `density: 1`, `noiseFrequency: 1`, `driftSpeed: 0` (static, not
 * animated), `raymarchSteps: 25`.
 */
export function Volume(props: VolumeProps): VolumeNode {
  return {
    id: props.id,
    kind: "volume",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    shape: props.shape ?? { type: "sphere", radius: 1 },
    color: props.color ?? [0.8, 0.8, 0.85, 1],
    density: props.density ?? 1,
    ...(props.noiseFrequency !== undefined && { noiseFrequency: props.noiseFrequency }),
    ...(props.driftSpeed !== undefined && { driftSpeed: props.driftSpeed }),
    ...(props.raymarchSteps !== undefined && { raymarchSteps: props.raymarchSteps }),
    ...(props.seed !== undefined && { seed: props.seed }),
  };
}
