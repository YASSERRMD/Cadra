import type {
  ColorRGBA,
  Property,
  SceneNode,
  TextGlowConfig,
  TextMorphConfig,
  TextNode,
  TextOutlineConfig,
  TextPathConfig,
  TextPathSegment,
  TextShadowConfig,
  TextStaggerGrouping,
  Vector3,
} from "@cadra/core";

/**
 * Reads and writes one animatable dot-path (a `PropertyDescriptor.path`,
 * e.g. `"transform.position"` or `"fontSize"`) on a `SceneNode`.
 *
 * Every path this app's inspector ever deals with (see
 * `NODE_KIND_PROPERTY_DESCRIPTORS` in `./property-descriptors.js`) is one of
 * three shapes: a bare top-level field (`"visible"`, `"color"`, `"fontSize"`,
 * `"opacity"`, `"target"`, `"fov"`, `"near"`, `"far"`, `"intensity"`),
 * `"transform.<field>"` for one of `position`/`rotation`/`scale` (a bag
 * every `SceneNode` always carries, never `undefined`), or (Phase 72)
 * `"<config>.<field>"` for one of a `MeshNode`'s inline `material` or a
 * `TextNode`'s `path`/`morph`/`outline`/`glow`/`shadow` effect config - each
 * of those, unlike `transform`, is itself optional on the node instance, so
 * a read falls back to that field's own default (matching whatever the
 * renderer itself resolves for an omitted field) and a write lazily
 * constructs the whole config (filling any other field the type requires
 * with its own default too) the first time one of its fields is edited on a
 * node that does not carry that config yet. Rather than a fully generic,
 * arbitrary-depth path walker (which would need `unknown`/`any` casts
 * throughout to type at all, since `SceneNode` is a strict, closed
 * discriminated union with no index signature), this module hand-writes
 * exactly those shapes, so every read/write stays fully typed against
 * `SceneNode`'s real fields with no `any`.
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
 * Per-field defaults for a `MeshNode`'s inline `material`, read when
 * `node.material` (or just the one field) is not yet authored. Mirror
 * `resolveMeshMaterial`'s own documented defaults (`@cadra/core`'s
 * `primitives/material.ts`) exactly, so a mesh with no `material` authored
 * yet displays the same values the renderer itself would resolve; keep
 * these in sync if that function's own defaults ever change.
 */
const DEFAULT_MATERIAL_BASE_COLOR: ColorRGBA = [0.7, 0.7, 0.7, 1];
const DEFAULT_MATERIAL_EMISSIVE: ColorRGBA = [0, 0, 0, 1];
const DEFAULT_MATERIAL_SHEEN_COLOR: ColorRGBA = [0, 0, 0, 1];

/**
 * Per-field starting values for a `TextNode`'s optional `outline`/`glow`/
 * `shadow`/`morph`/`path` effect configs: used both to display a value when
 * the config is not yet authored, and (via the `resolve*Base` helpers below)
 * to fill in whatever sibling field the type requires the first time one
 * field of a not-yet-authored config is edited. Unlike `MeshMaterialConfig`,
 * none of these configs has a canonical renderer-side default for their own
 * required fields (an outline/glow/shadow/morph/path only exists once fully
 * authored), so these are this inspector's own reasonable starting points,
 * not a mirror of some other module's defaults.
 */
const DEFAULT_OUTLINE_WIDTH = 0.05;
const DEFAULT_OUTLINE_COLOR: ColorRGBA = [0, 0, 0, 1];
const DEFAULT_GLOW_RADIUS = 0.1;
const DEFAULT_GLOW_COLOR: ColorRGBA = [1, 1, 1, 1];
const DEFAULT_SHADOW_OFFSET_X = 0.05;
const DEFAULT_SHADOW_OFFSET_Y = 0.05;
const DEFAULT_SHADOW_COLOR: ColorRGBA = [0, 0, 0, 0.5];
const DEFAULT_MORPH_FROM = "";
const DEFAULT_MORPH_GROUPING: TextStaggerGrouping = "character";
const DEFAULT_PATH_START: Vector3 = [0, 0, 0];
const DEFAULT_PATH_SEGMENTS: readonly TextPathSegment[] = [{ type: "line", to: [1, 0, 0] }];

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
    case "mesh":
      if (path === "material.baseColor") {
        return node.material?.baseColor ?? DEFAULT_MATERIAL_BASE_COLOR;
      }
      if (path === "material.metalness") {
        return node.material?.metalness ?? 0;
      }
      if (path === "material.roughness") {
        return node.material?.roughness ?? 0.5;
      }
      if (path === "material.emissive") {
        return node.material?.emissive ?? DEFAULT_MATERIAL_EMISSIVE;
      }
      if (path === "material.emissiveIntensity") {
        return node.material?.emissiveIntensity ?? 1;
      }
      if (path === "material.clearcoat") {
        return node.material?.clearcoat ?? 0;
      }
      if (path === "material.clearcoatRoughness") {
        return node.material?.clearcoatRoughness ?? 0;
      }
      if (path === "material.transmission") {
        return node.material?.transmission ?? 0;
      }
      if (path === "material.ior") {
        return node.material?.ior ?? 1.5;
      }
      if (path === "material.thickness") {
        return node.material?.thickness ?? 0;
      }
      if (path === "material.sheen") {
        return node.material?.sheen ?? 0;
      }
      if (path === "material.sheenRoughness") {
        return node.material?.sheenRoughness ?? 1;
      }
      if (path === "material.sheenColor") {
        return node.material?.sheenColor ?? DEFAULT_MATERIAL_SHEEN_COLOR;
      }
      if (path === "material.opacity") {
        return node.material?.opacity ?? 1;
      }
      break;
    case "text":
      if (path === "color") {
        return node.color;
      }
      if (path === "fontSize") {
        return node.fontSize;
      }
      if (path === "extrudeDepth") {
        return node.extrudeDepth ?? 0;
      }
      if (path === "path.progress") {
        return node.path?.progress ?? 1;
      }
      if (path === "path.startOffset") {
        return node.path?.startOffset ?? 0;
      }
      if (path === "morph.progress") {
        return node.morph?.progress ?? 0;
      }
      if (path === "outline.width") {
        return node.outline?.width ?? DEFAULT_OUTLINE_WIDTH;
      }
      if (path === "outline.color") {
        return node.outline?.color ?? DEFAULT_OUTLINE_COLOR;
      }
      if (path === "glow.radius") {
        return node.glow?.radius ?? DEFAULT_GLOW_RADIUS;
      }
      if (path === "glow.color") {
        return node.glow?.color ?? DEFAULT_GLOW_COLOR;
      }
      if (path === "glow.intensity") {
        return node.glow?.intensity ?? 1;
      }
      if (path === "shadow.offsetX") {
        return node.shadow?.offsetX ?? DEFAULT_SHADOW_OFFSET_X;
      }
      if (path === "shadow.offsetY") {
        return node.shadow?.offsetY ?? DEFAULT_SHADOW_OFFSET_Y;
      }
      if (path === "shadow.blur") {
        return node.shadow?.blur ?? 0;
      }
      if (path === "shadow.color") {
        return node.shadow?.color ?? DEFAULT_SHADOW_COLOR;
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
    case "mesh":
      if (path === "material.baseColor") {
        return { ...node, material: { ...node.material, baseColor: value as Property<ColorRGBA> } };
      }
      if (path === "material.metalness") {
        return { ...node, material: { ...node.material, metalness: value as Property<number> } };
      }
      if (path === "material.roughness") {
        return { ...node, material: { ...node.material, roughness: value as Property<number> } };
      }
      if (path === "material.emissive") {
        return { ...node, material: { ...node.material, emissive: value as Property<ColorRGBA> } };
      }
      if (path === "material.emissiveIntensity") {
        return {
          ...node,
          material: { ...node.material, emissiveIntensity: value as Property<number> },
        };
      }
      if (path === "material.clearcoat") {
        return { ...node, material: { ...node.material, clearcoat: value as Property<number> } };
      }
      if (path === "material.clearcoatRoughness") {
        return {
          ...node,
          material: { ...node.material, clearcoatRoughness: value as Property<number> },
        };
      }
      if (path === "material.transmission") {
        return { ...node, material: { ...node.material, transmission: value as Property<number> } };
      }
      if (path === "material.ior") {
        return { ...node, material: { ...node.material, ior: value as Property<number> } };
      }
      if (path === "material.thickness") {
        return { ...node, material: { ...node.material, thickness: value as Property<number> } };
      }
      if (path === "material.sheen") {
        return { ...node, material: { ...node.material, sheen: value as Property<number> } };
      }
      if (path === "material.sheenRoughness") {
        return {
          ...node,
          material: { ...node.material, sheenRoughness: value as Property<number> },
        };
      }
      if (path === "material.sheenColor") {
        return { ...node, material: { ...node.material, sheenColor: value as Property<ColorRGBA> } };
      }
      if (path === "material.opacity") {
        return { ...node, material: { ...node.material, opacity: value as Property<number> } };
      }
      break;
    case "text":
      if (path === "color") {
        return { ...node, color: value as Property<ColorRGBA> };
      }
      if (path === "fontSize") {
        return { ...node, fontSize: value as Property<number> };
      }
      if (path === "extrudeDepth") {
        return { ...node, extrudeDepth: value as Property<number> };
      }
      if (path === "path.progress") {
        return { ...node, path: { ...resolvePathBase(node), progress: value as Property<number> } };
      }
      if (path === "path.startOffset") {
        return {
          ...node,
          path: { ...resolvePathBase(node), startOffset: value as Property<number> },
        };
      }
      if (path === "morph.progress") {
        return { ...node, morph: { ...resolveMorphBase(node), progress: value as Property<number> } };
      }
      if (path === "outline.width") {
        return { ...node, outline: { ...resolveOutlineBase(node), width: value as Property<number> } };
      }
      if (path === "outline.color") {
        return {
          ...node,
          outline: { ...resolveOutlineBase(node), color: value as Property<ColorRGBA> },
        };
      }
      if (path === "glow.radius") {
        return { ...node, glow: { ...resolveGlowBase(node), radius: value as Property<number> } };
      }
      if (path === "glow.color") {
        return { ...node, glow: { ...resolveGlowBase(node), color: value as Property<ColorRGBA> } };
      }
      if (path === "glow.intensity") {
        return { ...node, glow: { ...resolveGlowBase(node), intensity: value as Property<number> } };
      }
      if (path === "shadow.offsetX") {
        return {
          ...node,
          shadow: { ...resolveShadowBase(node), offsetX: value as Property<number> },
        };
      }
      if (path === "shadow.offsetY") {
        return {
          ...node,
          shadow: { ...resolveShadowBase(node), offsetY: value as Property<number> },
        };
      }
      if (path === "shadow.blur") {
        return { ...node, shadow: { ...resolveShadowBase(node), blur: value as Property<number> } };
      }
      if (path === "shadow.color") {
        return {
          ...node,
          shadow: { ...resolveShadowBase(node), color: value as Property<ColorRGBA> },
        };
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

/** `node.outline`, or a fresh, minimal, schema-valid `TextOutlineConfig` (the `DEFAULT_OUTLINE_*` constants) when not yet authored - the base `setPropertyAtPath` spreads over before overriding the one field actually being edited. */
function resolveOutlineBase(node: TextNode): TextOutlineConfig {
  return node.outline ?? { width: DEFAULT_OUTLINE_WIDTH, color: DEFAULT_OUTLINE_COLOR };
}

/** `node.glow`, or a fresh, minimal, schema-valid `TextGlowConfig` when not yet authored; see `resolveOutlineBase`. */
function resolveGlowBase(node: TextNode): TextGlowConfig {
  return node.glow ?? { radius: DEFAULT_GLOW_RADIUS, color: DEFAULT_GLOW_COLOR };
}

/** `node.shadow`, or a fresh, minimal, schema-valid `TextShadowConfig` when not yet authored; see `resolveOutlineBase`. */
function resolveShadowBase(node: TextNode): TextShadowConfig {
  return (
    node.shadow ?? {
      offsetX: DEFAULT_SHADOW_OFFSET_X,
      offsetY: DEFAULT_SHADOW_OFFSET_Y,
      color: DEFAULT_SHADOW_COLOR,
    }
  );
}

/** `node.morph`, or a fresh, minimal, schema-valid `TextMorphConfig` when not yet authored; see `resolveOutlineBase`. */
function resolveMorphBase(node: TextNode): TextMorphConfig {
  return node.morph ?? { from: DEFAULT_MORPH_FROM, grouping: DEFAULT_MORPH_GROUPING, progress: 0 };
}

/** `node.path`, or a fresh, minimal, schema-valid `TextPathConfig` (a single straight segment) when not yet authored; see `resolveOutlineBase`. */
function resolvePathBase(node: TextNode): TextPathConfig {
  return node.path ?? { start: DEFAULT_PATH_START, segments: DEFAULT_PATH_SEGMENTS };
}
