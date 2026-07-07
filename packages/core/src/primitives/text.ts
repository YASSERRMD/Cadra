import type { Property } from "../keyframes/keyframe-track.js";
import {
  type AnimatableTransform,
  type ColorRGBA,
  createIdentityTransform,
} from "../scene-graph/primitives.js";
import type {
  TextFill,
  TextGlowConfig,
  TextMorphConfig,
  TextNode,
  TextOutlineConfig,
  TextPathConfig,
  TextPhysicsConfig,
  TextShadowConfig,
  TextStaggerConfig,
} from "../scene-graph/scene-node.js";

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
  extrudeDepth?: Property<number>;
  stagger?: TextStaggerConfig;
  physics?: TextPhysicsConfig;
  path?: TextPathConfig;
  morph?: TextMorphConfig;
  fill?: TextFill;
  outline?: TextOutlineConfig;
  glow?: TextGlowConfig;
  shadow?: TextShadowConfig;
  variationAxes?: Property<Readonly<Record<string, number>>>;
}

/**
 * Creates a `TextNode`: a block of rendered text.
 *
 * Defaults: identity transform, `visible: true`, no children, empty
 * `content`, `fontSize: 24`, opaque white `color`. `fontRef` is left
 * `undefined` unless supplied, matching `TextNode`'s "omitted means the
 * renderer's default" convention; `extrudeDepth` is likewise left
 * `undefined` unless supplied, matching its own "omitted means flat" default;
 * `stagger`/`physics`/`path`/`morph`/`fill`/`outline`/`glow`/`shadow`/
 * `variationAxes` are likewise left `undefined` unless supplied, matching
 * their own "omitted means no staggering"/"no physics effect"/"a normal
 * flat layout"/"no morphing"/"a plain color fill"/"no outline"/"no glow"/
 * "no shadow"/"the font's own default instance" defaults.
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
    ...(props.extrudeDepth !== undefined && { extrudeDepth: props.extrudeDepth }),
    ...(props.stagger !== undefined && { stagger: props.stagger }),
    ...(props.physics !== undefined && { physics: props.physics }),
    ...(props.path !== undefined && { path: props.path }),
    ...(props.morph !== undefined && { morph: props.morph }),
    ...(props.fill !== undefined && { fill: props.fill }),
    ...(props.outline !== undefined && { outline: props.outline }),
    ...(props.glow !== undefined && { glow: props.glow }),
    ...(props.shadow !== undefined && { shadow: props.shadow }),
    ...(props.variationAxes !== undefined && { variationAxes: props.variationAxes }),
  };
}
