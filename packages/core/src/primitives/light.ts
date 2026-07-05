import { type ColorRGBA, createIdentityTransform, type Transform } from "../scene-graph/primitives.js";
import type { LightNode, LightType } from "../scene-graph/scene-node.js";

/** Props for `Light`. Only `id` is required; everything else defaults. */
export interface LightProps {
  id: string;
  name?: string;
  transform?: Transform;
  visible?: boolean;
  children?: LightNode["children"];
  lightType?: LightType;
  color?: ColorRGBA;
  intensity?: number;
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
