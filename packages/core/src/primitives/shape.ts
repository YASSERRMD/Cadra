import { createIdentityTransform, type Transform } from "../scene-graph/primitives.js";
import type { MeshNode } from "../scene-graph/scene-node.js";

/**
 * Props for `Shape`. Only `id` is required; everything else defaults.
 *
 * `geometryRef` and `materialRef` are plain strings the caller supplies, not
 * validated against any registry here: `@cadra/core` never imports
 * `@cadra/renderer`, so it has no visibility into which refs a renderer's
 * registries actually resolve. `"box"` and `"default"` are chosen only as
 * zero-config, readable placeholder literals.
 */
export interface ShapeProps {
  id: string;
  name?: string;
  transform?: Transform;
  visible?: boolean;
  children?: MeshNode["children"];
  geometryRef?: string;
  materialRef?: string;
}

/**
 * Creates a `MeshNode`: a renderable shape.
 *
 * Defaults: identity transform, `visible: true`, no children,
 * `geometryRef: "box"`, `materialRef: "default"`.
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
  };
}
