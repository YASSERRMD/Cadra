import type { ColorRGBA, Property, SceneNode, Vector3 } from "@cadra/core";

/**
 * Reads and writes one animatable dot-path (a `PropertyDescriptor.path`,
 * e.g. `"transform.position"` or `"fontSize"`) on a `SceneNode`.
 *
 * Every path this app's inspector ever deals with (see
 * `NODE_KIND_PROPERTY_DESCRIPTORS` in `./property-descriptors.js`) is
 * exactly one of two shapes: a bare top-level field (`"visible"`,
 * `"color"`, `"fontSize"`, `"opacity"`, `"target"`, `"fov"`, `"near"`,
 * `"far"`, `"intensity"`), or `"transform.<field>"` for one of
 * `position`/`rotation`/`scale`. Rather than a fully generic, arbitrary-
 * depth path walker (which would need `unknown`/`any` casts throughout to
 * type at all, since `SceneNode` is a strict, closed discriminated union
 * with no index signature), this module hand-writes exactly those two
 * shapes, so every read/write stays fully typed against `SceneNode`'s real
 * fields with no `any`.
 *
 * A caller is expected to have already checked (via
 * `NODE_KIND_PROPERTY_DESCRIPTORS[node.kind]`) that `path` is actually a
 * property this node's `kind` carries; `getPropertyAtPath`/
 * `setPropertyAtPath` both throw if it is not, rather than silently
 * returning/ignoring a value, since a caller reaching this module with an
 * unsupported path for the given node kind is a genuine programming error.
 */

/** The plain constant/`KeyframeTrack` union of every value shape a `SceneNode`'s animatable properties can hold. */
export type AnyPropertyValue = Property<number> | Property<Vector3> | Property<ColorRGBA> | Property<boolean>;

/** A record shape with a `Property<T>`-typed `transform` bag, matching every `SceneNode` variant's shared `transform` field. */
interface HasTransform {
  transform: {
    position: Property<Vector3>;
    rotation: Property<Vector3>;
    scale: Property<Vector3>;
  };
}

/**
 * Reads the `Property<T>` currently at `path` on `node`. Returns the exact
 * value stored (a plain constant or a `KeyframeTrack`, unresolved: this is a
 * raw read, not `resolveNumberProperty`/etc., which the caller applies
 * separately at whatever frame it needs a concrete display value for).
 *
 * @throws if `path` names a field `node`'s own `kind` does not actually
 *   carry (e.g. `"fov"` on a non-`"camera"` node). A caller should always
 *   have already filtered `path` through `NODE_KIND_PROPERTY_DESCRIPTORS`
 *   for this exact `node.kind` first.
 */
export function getPropertyAtPath(node: SceneNode, path: string): AnyPropertyValue {
  if (path === "transform.position") {
    return node.transform.position;
  }
  if (path === "transform.rotation") {
    return node.transform.rotation;
  }
  if (path === "transform.scale") {
    return node.transform.scale;
  }
  if (path === "visible") {
    return node.visible;
  }

  switch (node.kind) {
    case "text":
      if (path === "color") {
        return node.color;
      }
      if (path === "fontSize") {
        return node.fontSize;
      }
      break;
    case "video":
      if (path === "opacity") {
        return node.opacity;
      }
      break;
    case "satori":
      if (path === "opacity") {
        return node.opacity;
      }
      break;
    case "camera":
      if (path === "target") {
        return node.target;
      }
      if (path === "fov") {
        return node.fov;
      }
      if (path === "near") {
        return node.near;
      }
      if (path === "far") {
        return node.far;
      }
      break;
    case "light":
      if (path === "color") {
        return node.color;
      }
      if (path === "intensity") {
        return node.intensity;
      }
      break;
    default:
      break;
  }

  throw new Error(
    `getPropertyAtPath: node kind "${node.kind}" has no animatable property at path "${path}".`,
  );
}

/**
 * Returns a new `SceneNode` equal to `node` except that `path` now holds
 * `value`. Immutable (never mutates `node`); the caller is expected to
 * splice the result back into the scene tree itself, e.g. via
 * `updateNode(root, node.id, () => setPropertyAtPath(node, path, value))`.
 *
 * `value`'s runtime shape is expected to already match `path`'s
 * `PropertyValueKind` (a caller building it from a `PropertyDescriptor`'s
 * own `valueKind` and one of the `resolve*Property`/plain-value editors
 * always satisfies this); this function does not itself re-validate the
 * shape; unlike `getPropertyAtPath`'s own path-not-supported guard, an
 * incorrect `value` shape is caught downstream by `commitDocument`'s
 * `parseScene` gate instead (a wrong-shaped value fails schema validation
 * exactly like every other invalid edit this store rejects).
 *
 * @throws if `path` names a field `node`'s own `kind` does not actually
 *   carry, same as `getPropertyAtPath`.
 */
export function setPropertyAtPath(node: SceneNode, path: string, value: AnyPropertyValue): SceneNode {
  if (path === "transform.position" || path === "transform.rotation" || path === "transform.scale") {
    return setTransformField(node, path, value as Property<Vector3>);
  }
  if (path === "visible") {
    return { ...node, visible: value as Property<boolean> };
  }

  switch (node.kind) {
    case "text":
      if (path === "color") {
        return { ...node, color: value as Property<ColorRGBA> };
      }
      if (path === "fontSize") {
        return { ...node, fontSize: value as Property<number> };
      }
      break;
    case "video":
      if (path === "opacity") {
        return { ...node, opacity: value as Property<number> };
      }
      break;
    case "satori":
      if (path === "opacity") {
        return { ...node, opacity: value as Property<number> };
      }
      break;
    case "camera":
      if (path === "target") {
        return { ...node, target: value as Property<Vector3> };
      }
      if (path === "fov") {
        return { ...node, fov: value as Property<number> };
      }
      if (path === "near") {
        return { ...node, near: value as Property<number> };
      }
      if (path === "far") {
        return { ...node, far: value as Property<number> };
      }
      break;
    case "light":
      if (path === "color") {
        return { ...node, color: value as Property<ColorRGBA> };
      }
      if (path === "intensity") {
        return { ...node, intensity: value as Property<number> };
      }
      break;
    default:
      break;
  }

  throw new Error(
    `setPropertyAtPath: node kind "${node.kind}" has no animatable property at path "${path}".`,
  );
}

/** Shared by `setPropertyAtPath` for the three `"transform.*"` paths: replaces exactly one field of `node.transform`, keeping the rest and every other field of `node` unchanged. */
function setTransformField<Node extends SceneNode & HasTransform>(
  node: Node,
  path: "transform.position" | "transform.rotation" | "transform.scale",
  value: Property<Vector3>,
): Node {
  const field = path === "transform.position" ? "position" : path === "transform.rotation" ? "rotation" : "scale";
  return {
    ...node,
    transform: {
      ...node.transform,
      [field]: value,
    },
  };
}
