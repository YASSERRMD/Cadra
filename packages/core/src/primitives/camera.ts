import { createIdentityTransform, type Transform, type Vector3 } from "../scene-graph/primitives.js";
import type { CameraNode } from "../scene-graph/scene-node.js";

/** Props for `Camera`. Only `id` is required; everything else defaults. */
export interface CameraProps {
  id: string;
  name?: string;
  transform?: Transform;
  visible?: boolean;
  children?: CameraNode["children"];
  fov?: number;
  near?: number;
  far?: number;
  target?: Vector3;
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
