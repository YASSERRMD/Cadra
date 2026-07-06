import type { Property } from "../keyframes/keyframe-track.js";
import {
  type AnimatableTransform,
  createIdentityTransform,
  type Vector3,
} from "../scene-graph/primitives.js";
import type { CameraNode } from "../scene-graph/scene-node.js";

/**
 * Props for `Camera`. Only `id` is required; everything else defaults.
 *
 * `transform`, `visible`, `fov`, `near`, `far`, and `target` each accept
 * either a plain value or a `KeyframeTrack` (Phase 10's `Property<T>`);
 * passing a plain value, as every existing caller does, keeps working
 * unchanged.
 */
export interface CameraProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: CameraNode["children"];
  fov?: Property<number>;
  near?: Property<number>;
  far?: Property<number>;
  target?: Property<Vector3>;
}

/**
 * Creates a `CameraNode`.
 *
 * Defaults: identity transform, `visible: true`, no children, `fov: 50`
 * (degrees), `near: 0.1`, `far: 1000`, `target: [0, 0, 0]`.
 */
export function Camera(props: CameraProps): CameraNode {
  return {
    id: props.id,
    kind: "camera",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    fov: props.fov ?? 50,
    near: props.near ?? 0.1,
    far: props.far ?? 1000,
    target: props.target ?? [0, 0, 0],
  };
}
