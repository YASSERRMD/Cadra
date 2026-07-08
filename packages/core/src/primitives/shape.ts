import type { Property } from "../keyframes/keyframe-track.js";
import { type AnimatableTransform, createIdentityTransform } from "../scene-graph/primitives.js";
import type { MeshMaterialConfig, MeshNode, RigidBodyConfig } from "../scene-graph/scene-node.js";

/**
 * Props for `Shape`. Only `id` is required; everything else defaults.
 *
 * `geometryRef` and `materialRef` are plain strings the caller supplies, not
 * validated against any registry here: `@cadra/core` never imports
 * `@cadra/renderer`, so it has no visibility into which refs a renderer's
 * registries actually resolve. `"box"` and `"default"` are chosen only as
 * zero-config, readable placeholder literals.
 *
 * `material`, when provided, takes over from `materialRef` entirely (see
 * `MeshMaterialConfig`'s own doc); omit it to keep using `materialRef`'s
 * registry-resolved material, the pre-Phase-55 default.
 *
 * `rigidBody`, when provided, makes this shape physics-driven (see
 * `RigidBodyConfig`'s own doc, Phase 66); omit it to keep this shape's
 * `transform` resolving exactly as it did before Phase 66.
 *
 * `transform` and `visible` each accept either a plain value or a
 * `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain value, as every
 * existing caller does, keeps working unchanged.
 */
export interface ShapeProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: MeshNode["children"];
  geometryRef?: string;
  materialRef?: string;
  material?: MeshMaterialConfig;
  castShadow?: boolean;
  receiveShadow?: boolean;
  rigidBody?: RigidBodyConfig;
}

/**
 * Creates a `MeshNode`: a renderable shape.
 *
 * Defaults: identity transform, `visible: true`, no children,
 * `geometryRef: "box"`, `materialRef: "default"`, no inline `material`,
 * `castShadow`/`receiveShadow` both `false`, and no `rigidBody` (not
 * physics-driven).
 */
export function Shape(props: ShapeProps): MeshNode {
  return {
    id: props.id,
    kind: "mesh",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    geometryRef: props.geometryRef ?? "box",
    materialRef: props.materialRef ?? "default",
    ...(props.material !== undefined && { material: props.material }),
    ...(props.castShadow !== undefined && { castShadow: props.castShadow }),
    ...(props.receiveShadow !== undefined && { receiveShadow: props.receiveShadow }),
    ...(props.rigidBody !== undefined && { rigidBody: props.rigidBody }),
  };
}
