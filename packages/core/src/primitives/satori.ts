import type { Property } from "../keyframes/keyframe-track.js";
import type { LayerElement } from "../scene-graph/layer-element.js";
import { type AnimatableTransform, createIdentityTransform } from "../scene-graph/primitives.js";
import type {
  SatoriBlendMode,
  SatoriElementKeyframes,
  SatoriLayerFontRef,
  SatoriNode,
} from "../scene-graph/scene-node.js";

/**
 * Props for `Satori`. Only `id`, `layer`, `width`, and `height` are
 * required (a layer with no content and no rendering resolution has
 * nothing to place); everything else defaults.
 */
export interface SatoriProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: SatoriNode["children"];
  layer: LayerElement;
  width: number;
  height: number;
  opacity?: Property<number>;
  blendMode?: SatoriBlendMode;
  fonts?: readonly SatoriLayerFontRef[];
  elementAnimations?: Readonly<Record<string, SatoriElementKeyframes>>;
}

/**
 * Creates a `SatoriNode`: a Satori-rendered 2D layer placed as a textured
 * plane on the timeline.
 *
 * Defaults: identity transform, `visible: true`, no children, no
 * `blendMode` (renders as `'normal'`), no `fonts` (valid only when `layer`
 * has no text), no `elementAnimations`, `opacity: 1`.
 */
export function Satori(props: SatoriProps): SatoriNode {
  return {
    id: props.id,
    kind: "satori",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    layer: props.layer,
    width: props.width,
    height: props.height,
    opacity: props.opacity ?? 1,
    ...(props.blendMode !== undefined && { blendMode: props.blendMode }),
    ...(props.fonts !== undefined && { fonts: props.fonts }),
    ...(props.elementAnimations !== undefined && { elementAnimations: props.elementAnimations }),
  };
}
