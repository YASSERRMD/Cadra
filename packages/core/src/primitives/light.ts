import type { Property } from "../keyframes/keyframe-track.js";
import {
  type AnimatableTransform,
  type ColorRGBA,
  createIdentityTransform,
} from "../scene-graph/primitives.js";
import type { LightNode, LightShadowConfig, LightType } from "../scene-graph/scene-node.js";

/**
 * Props for `Light`. Only `id` is required; everything else defaults.
 *
 * `transform`, `visible`, `color`, and `intensity` each accept either a plain
 * value or a `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain
 * value, as every existing caller does, keeps working unchanged.
 *
 * `castShadow`/`shadow`/`distance`/`decay`/`angle`/`penumbra`/`width`/
 * `height` mirror `LightNode`'s own fields of the same names exactly (see
 * each one's own doc comment there for defaults and which `lightType`(s)
 * they apply to); every one is omittable, and omitting all of them keeps
 * this function's pre-Phase-55 behavior unchanged.
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
  castShadow?: boolean;
  shadow?: LightShadowConfig;
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
  width?: number;
  height?: number;
}

/**
 * Creates a `LightNode`.
 *
 * Defaults: identity transform, `visible: true`, no children,
 * `lightType: "directional"`, opaque white `color`, `intensity: 1`, no
 * shadow casting, and every physical falloff/area field left at Three.js's
 * own defaults.
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
    ...(props.castShadow !== undefined && { castShadow: props.castShadow }),
    ...(props.shadow !== undefined && { shadow: props.shadow }),
    ...(props.distance !== undefined && { distance: props.distance }),
    ...(props.decay !== undefined && { decay: props.decay }),
    ...(props.angle !== undefined && { angle: props.angle }),
    ...(props.penumbra !== undefined && { penumbra: props.penumbra }),
    ...(props.width !== undefined && { width: props.width }),
    ...(props.height !== undefined && { height: props.height }),
  };
}
