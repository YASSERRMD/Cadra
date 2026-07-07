import type { SceneNodeKind } from "@cadra/core";
import {
  CAMERA_ANIMATABLE_PROPERTIES,
  IMAGE_ANIMATABLE_PROPERTIES,
  LIGHT_ANIMATABLE_PROPERTIES,
  SHAPE_ANIMATABLE_PROPERTIES,
  TEXT_ANIMATABLE_PROPERTIES,
  VIDEO_ANIMATABLE_PROPERTIES,
} from "@cadra/core";

/**
 * Which concrete value shape a given animatable dot-path resolves to, and
 * therefore which `resolve*Property` function (from `@cadra/core`'s
 * `keyframes/compile.ts`) reads it, and which plain-value editor widget
 * `PropertyEditor` (see `../components/PropertyEditor.js`) renders for it.
 *
 * This is metadata this app's inspector needs (Phase 39's task 1: "render
 * property editors driven by each primitive property descriptor") that
 * `@cadra/core`'s own `*_ANIMATABLE_PROPERTIES` lists deliberately do not
 * carry themselves (those lists are just dot-paths, documented prose-only
 * as to their shape; see that module's own doc). Kept here, in the studio
 * app, rather than added to `@cadra/core`, since "which editor widget to
 * render" is UI concern, not scene-graph metadata.
 */
export type PropertyValueKind = "number" | "vector3" | "color" | "boolean";

/** One animatable property this app's inspector can show an editor for: a dot-path plus its value kind. */
export interface PropertyDescriptor {
  /** Dot-path into the `SceneNode`, e.g. `"transform.position"` or `"fontSize"`. Matches one entry of the corresponding `*_ANIMATABLE_PROPERTIES` list exactly. */
  path: string;
  /** A short, human-readable label derived from `path`, e.g. `"Position"` for `"transform.position"`. */
  label: string;
  /** Which value shape/resolver this property uses. */
  valueKind: PropertyValueKind;
}

/** The shared `Transform` properties every node kind carries, each a `Property<Vector3>`. Mirrors `TRANSFORM_ANIMATABLE_PROPERTIES` in `@cadra/core`'s `animatable-properties.ts` (not itself exported, so re-derived here from its known dot-paths and shape). */
const TRANSFORM_DESCRIPTORS: PropertyDescriptor[] = [
  { path: "transform.position", label: "Position", valueKind: "vector3" },
  { path: "transform.rotation", label: "Rotation", valueKind: "vector3" },
  { path: "transform.scale", label: "Scale", valueKind: "vector3" },
];

/** `visible` (`Property<boolean>`), carried by every node kind. */
const VISIBLE_DESCRIPTOR: PropertyDescriptor = { path: "visible", label: "Visible", valueKind: "boolean" };

/**
 * Maps each dot-path in a `*_ANIMATABLE_PROPERTIES` list to its
 * `PropertyDescriptor` (adding the `label`/`valueKind` metadata that list
 * alone does not carry), for property lists built entirely out of the
 * shared `TRANSFORM_DESCRIPTORS`/`VISIBLE_DESCRIPTOR` plus a fixed tail of
 * kind-specific properties. `extra` supplies exactly those additional
 * descriptors, one per dot-path in `list` beyond `"transform.*"`/`"visible"`
 * (in the same order `list` has them), so this function never needs its own
 * copy of which extra paths a given node kind has: that is `list` itself,
 * already the definitive source `@cadra/core` exports.
 */
function buildDescriptors(
  list: ReadonlyArray<string>,
  extra: ReadonlyMap<string, PropertyDescriptor>,
): PropertyDescriptor[] {
  return list.map((path) => {
    if (path === "visible") {
      return VISIBLE_DESCRIPTOR;
    }
    const transformMatch = TRANSFORM_DESCRIPTORS.find((descriptor) => descriptor.path === path);
    if (transformMatch !== undefined) {
      return transformMatch;
    }
    const extraMatch = extra.get(path);
    if (extraMatch === undefined) {
      throw new Error(
        `property-descriptors: no PropertyDescriptor metadata registered for path "${path}". ` +
          "Add it to the relevant 'extra' map in property-descriptors.ts.",
      );
    }
    return extraMatch;
  });
}

/** Extra (beyond transform/visible) descriptors for `TEXT_ANIMATABLE_PROPERTIES`. */
const TEXT_EXTRA_DESCRIPTORS = new Map<string, PropertyDescriptor>([
  ["color", { path: "color", label: "Color", valueKind: "color" }],
  ["fontSize", { path: "fontSize", label: "Font Size", valueKind: "number" }],
  ["extrudeDepth", { path: "extrudeDepth", label: "Extrude Depth", valueKind: "number" }],
]);

/** Extra descriptors for `VIDEO_ANIMATABLE_PROPERTIES`. */
const VIDEO_EXTRA_DESCRIPTORS = new Map<string, PropertyDescriptor>([
  ["opacity", { path: "opacity", label: "Opacity", valueKind: "number" }],
]);

/** Extra descriptors for `CAMERA_ANIMATABLE_PROPERTIES`. */
const CAMERA_EXTRA_DESCRIPTORS = new Map<string, PropertyDescriptor>([
  ["target", { path: "target", label: "Target", valueKind: "vector3" }],
  ["fov", { path: "fov", label: "Field of View", valueKind: "number" }],
  ["near", { path: "near", label: "Near Plane", valueKind: "number" }],
  ["far", { path: "far", label: "Far Plane", valueKind: "number" }],
]);

/** Extra descriptors for `LIGHT_ANIMATABLE_PROPERTIES`. */
const LIGHT_EXTRA_DESCRIPTORS = new Map<string, PropertyDescriptor>([
  ["color", { path: "color", label: "Color", valueKind: "color" }],
  ["intensity", { path: "intensity", label: "Intensity", valueKind: "number" }],
]);

/**
 * Every `PropertyDescriptor` for each `SceneNodeKind`, derived from
 * `@cadra/core`'s own `*_ANIMATABLE_PROPERTIES` lists (Phase 7's per-
 * primitive property descriptors, the exact source Phase 39's task 1 calls
 * for). `"group"` and `"compositionRef"` are not covered by any of those
 * named lists (they have no kind-specific animatable fields beyond the
 * shared transform/visible every node kind carries; see
 * `@cadra/renderer`'s `applyNodeProperties`, whose `"group"`/
 * `"compositionRef"` cases apply only the shared transform/visibility and
 * return immediately), so both map directly to `TRANSFORM_DESCRIPTORS` plus
 * `VISIBLE_DESCRIPTOR` with no kind-specific tail.
 */
export const NODE_KIND_PROPERTY_DESCRIPTORS: Record<SceneNodeKind, PropertyDescriptor[]> = {
  group: [...TRANSFORM_DESCRIPTORS, VISIBLE_DESCRIPTOR],
  compositionRef: [...TRANSFORM_DESCRIPTORS, VISIBLE_DESCRIPTOR],
  mesh: buildDescriptors(SHAPE_ANIMATABLE_PROPERTIES, new Map()),
  text: buildDescriptors(TEXT_ANIMATABLE_PROPERTIES, TEXT_EXTRA_DESCRIPTORS),
  image: buildDescriptors(IMAGE_ANIMATABLE_PROPERTIES, new Map()),
  video: buildDescriptors(VIDEO_ANIMATABLE_PROPERTIES, VIDEO_EXTRA_DESCRIPTORS),
  camera: buildDescriptors(CAMERA_ANIMATABLE_PROPERTIES, CAMERA_EXTRA_DESCRIPTORS),
  light: buildDescriptors(LIGHT_ANIMATABLE_PROPERTIES, LIGHT_EXTRA_DESCRIPTORS),
};
