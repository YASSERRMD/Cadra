import type { Property } from "../keyframes/keyframe-track.js";
import { type AnimatableTransform, createIdentityTransform } from "../scene-graph/primitives.js";
import type { ModelClipConfig, ModelNode } from "../scene-graph/scene-node.js";

/**
 * Props for `Model`. Unlike `Shape`/`Image`/`Video`, `assetRef` has no
 * built-in default: there is no pre-seeded "default" GLTF model the way
 * geometry/material/image/video registries each ship a small built-in set,
 * so a caller must always say which asset to load.
 *
 * `transform`, `visible`, and every `clips[].weight`/`morphTargets[name]`
 * each accept either a plain value or a `KeyframeTrack` (Phase 10's
 * `Property<T>`); passing a plain value, as every existing caller of every
 * other primitive does, keeps working unchanged.
 */
export interface ModelProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: ModelNode["children"];
  assetRef: string;
  castShadow?: boolean;
  receiveShadow?: boolean;
  clips?: ModelClipConfig[];
  morphTargets?: Record<string, Property<number>>;
}

/**
 * Creates a `ModelNode`: a loaded GLTF/GLB model (Phase 69), optionally
 * skinned and/or morph-target animated.
 *
 * Defaults: identity transform, `visible: true`, no children,
 * `castShadow`/`receiveShadow` both `false`, no `clips` (the asset's own
 * bind pose, unanimated), no `morphTargets` (every morph target stays at the
 * asset's own authored default influence).
 */
export function Model(props: ModelProps): ModelNode {
  return {
    id: props.id,
    kind: "model",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    assetRef: props.assetRef,
    ...(props.castShadow !== undefined && { castShadow: props.castShadow }),
    ...(props.receiveShadow !== undefined && { receiveShadow: props.receiveShadow }),
    ...(props.clips !== undefined && { clips: props.clips }),
    ...(props.morphTargets !== undefined && { morphTargets: props.morphTargets }),
  };
}
