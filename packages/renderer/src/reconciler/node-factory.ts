import {
  type AnimatableTransform,
  type LightNode,
  type LightType,
  resolveBooleanProperty,
  resolveColorProperty,
  resolveNumberProperty,
  resolveVector3Property,
  type SatoriBlendMode,
  type SatoriNode,
  type SceneNode,
  type TextNode,
} from "@cadra/core";
import type { PositionedGlyph } from "@cadra/text/browser";
import * as THREE from "three";

import { createSvgTexture } from "../svg-layer/create-svg-texture.js";
import {
  computeSatoriLayerRenderKey,
  type SatoriLayerRenderRegistry,
} from "../svg-layer/satori-layer-render-registry.js";
import { applyTextEffects } from "../text/apply-text-effects.js";
import { buildTextGroup, type TextGroupResources } from "../text/build-text-group.js";
import { computeTextNodeRenderKey, type TextRenderRegistry } from "../text/text-render-registry.js";
import type { GeometryRegistry, MaterialRegistry } from "./registries.js";

/**
 * Geometry shared by every `text`, `image`, and `video` placeholder node,
 * module-level so it is constructed exactly once per process and never
 * disposed: the same ownership rule as a registry-provided geometry (see
 * `registries.ts`), even though this one lives here rather than in a
 * registry, since these placeholders are not `mesh` nodes and do not go
 * through `geometryRef`.
 *
 * Real glyph rendering (text), real texture loading (image), and real video
 * texture decoding/display (video) are all deferred: text to a future
 * font/glyph system, image to Phase 12's asset pipeline, video to a future
 * phase (out of scope for Phase 33, which focuses on the data model and
 * frame-mapping math; see `VideoNode`'s own doc comment in `@cadra/core`).
 * This plane is purely a visible stand-in shape until then.
 */
const PLACEHOLDER_PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1);

/** Fallback color for `image` placeholders, since `assetRef` cannot resolve to real image data yet. */
const IMAGE_PLACEHOLDER_COLOR = 0x808080;

/**
 * Fallback color for `video` placeholders, since `assetRef` cannot resolve to
 * a decoded video frame yet. Distinct from `IMAGE_PLACEHOLDER_COLOR` (a
 * darker gray) purely so the two placeholder kinds are visually
 * distinguishable in a rendered preview, with no other significance.
 */
const VIDEO_PLACEHOLDER_COLOR = 0x404040;

/**
 * Fallback geometry/material used when a mesh's `geometryRef`/`materialRef`
 * does not resolve in the injected registries ("not yet loaded" is an
 * expected runtime state, not a programming error). Module-level singletons,
 * pooled and never disposed by the reconciler, for the same reason a
 * registry's own resources are never disposed: many nodes may fall back to
 * these at once, and recreating them every `reconcile` call would be pure
 * waste.
 */
const DEFAULT_MESH_GEOMETRY = new THREE.BoxGeometry(0.5, 0.5, 0.5);
const DEFAULT_MESH_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x999999 });

/**
 * Dependencies the node factory needs to build/update `mesh`, `text`, and
 * `satori` nodes. Kept as one bag so `createThreeObject`/`applyNodeProperties`
 * share a single signature regardless of node kind. `textRenderRegistry`/
 * `satoriLayerRenderRegistry` are both optional (omitting either renders
 * every node of that kind as an empty group, the same "asset not ready"
 * fallback `image`/`video` placeholders are still waiting on their own
 * asset pipeline wiring to outgrow) so every existing caller that never
 * touches text or Satori layers keeps compiling unchanged.
 */
export interface NodeFactoryContext {
  geometryRegistry: GeometryRegistry;
  materialRegistry: MaterialRegistry;
  textRenderRegistry?: TextRenderRegistry;
  satoriLayerRenderRegistry?: SatoriLayerRenderRegistry;
}

/**
 * A `satori` node's own owned resources: a stable outer `group` (the
 * node's own `object3D`, never swapped) holding at most one `mesh`, built
 * lazily once a `SatoriLayerRenderEntry` first resolves and then swapped
 * (not rebuilt from scratch) whenever a later frame resolves to a
 * different one - `geometry` is the one exception, sized once from
 * `SatoriNode.width`/`height` (fixed, non-`Property<T>` fields; see that
 * type's own doc for why) and reused across every texture swap, since
 * only the pixels themselves ever change from frame to frame, never the
 * plane's own dimensions.
 */
export interface SatoriLayerResources {
  group: THREE.Group;
  geometry: THREE.PlaneGeometry;
  mesh?: THREE.Mesh;
  material?: THREE.Material;
  texture?: THREE.Texture;
  /** The `computeSatoriLayerRenderKey` this node's current `mesh`/`material`/`texture` were last built from, so `applyNodeProperties` only rebuilds them when a new frame actually resolves to different pixels, not on every single frame. */
  lastRenderKey?: string;
}

/**
 * Resources the reconciler itself created and therefore owns for a given
 * node id, as opposed to anything obtained from a registry. Only these are
 * ever disposed by the reconciler (see `disposeOwnedResources`).
 *
 * `mesh`, `camera`, `light`, `group`, and `compositionRef` nodes own nothing
 * beyond their `Object3D` itself (their geometry/material are registry-owned,
 * or they have none), so this is `undefined` for them.
 */
export interface OwnedResources {
  /** The per-node placeholder material created for an `image` node (or a `text` node whose render data was not ready when built). */
  material?: THREE.Material;
  /**
   * A `text` node's own geometries/materials/textures, built once from its
   * resolved `TextRenderEntry` (see `text/build-text-group.ts`). Its own
   * `setColor` is what `applyNodeProperties` calls to push a per-frame
   * resolved `color` onto whichever material(s) are actually in play
   * (per-atlas-page MSDF materials for the flat path, one shared
   * `MeshStandardMaterial` for the extruded path) without rebuilding any
   * geometry.
   */
  text?: TextGroupResources;
  /**
   * The exact glyph array `text` above was built from, kept around only so
   * a later `applyNodeProperties` call can drive `node.stagger`/
   * `node.physics` (Phase 50/51): that registry-resolved data is only ever
   * on hand inside `buildTextObject` itself, not on every subsequent
   * per-frame call.
   */
  textGlyphs?: readonly PositionedGlyph[];
  /** A `satori` node's own owned resources; see `SatoriLayerResources`'s own doc. */
  satori?: SatoriLayerResources;
}

/** The result of building a fresh Three.js object for a node: the object plus what it owns. */
interface BuiltObject {
  object3D: THREE.Object3D;
  owned: OwnedResources | undefined;
}

/**
 * Creates a fresh `THREE.Object3D` for `node`, per the kind mapping this
 * reconciler implements: group -> Group, mesh -> Mesh (registry-resolved
 * geometry/material), camera -> PerspectiveCamera, light -> the matching
 * THREE light class, text/image -> a shared-plane-plus-owned-material
 * placeholder, compositionRef -> an empty Group (splicing in the referenced
 * composition's content is the timeline resolver's job in a later phase, not
 * this reconciler's, since it only ever sees one SceneNode tree at a time).
 *
 * Every returned `object3D.name` is set to `node.id`: Three.js's own public
 * bookkeeping field for exactly this purpose, so later code (e.g. the
 * renderer's active-camera lookup) can find a specific reconciled object by
 * the `SceneNode.id` that produced it via `Object3D.getObjectByName`/`.traverse`.
 *
 * Does not apply transform/visibility; call `applyNodeProperties` right after.
 */
export function createThreeObject(node: SceneNode, ctx: NodeFactoryContext): BuiltObject {
  const built = buildThreeObject(node, ctx);
  built.object3D.name = node.id;
  return built;
}

/** The kind-mapping switch itself, factored out so `createThreeObject` can tag the result in one place. */
function buildThreeObject(node: SceneNode, ctx: NodeFactoryContext): BuiltObject {
  switch (node.kind) {
    case "group":
    case "compositionRef":
      return { object3D: new THREE.Group(), owned: undefined };

    case "mesh": {
      const geometry = resolveMeshGeometry(node.geometryRef, ctx.geometryRegistry);
      const material = resolveMeshMaterial(node.materialRef, ctx.materialRegistry);
      return { object3D: new THREE.Mesh(geometry, material), owned: undefined };
    }

    case "camera": {
      // fov/near/far are Property<number> now, not resolved to a concrete
      // value here: applyNodeProperties (called unconditionally right after
      // this, for every node on every reconcile) sets the real,
      // frame-resolved values, so the constructor's own defaults are never
      // actually observed.
      return { object3D: new THREE.PerspectiveCamera(), owned: undefined };
    }

    case "light":
      return { object3D: createLight(node.lightType), owned: undefined };

    case "text":
      return buildTextObject(node, ctx);

    case "image": {
      const material = new THREE.MeshBasicMaterial({ color: IMAGE_PLACEHOLDER_COLOR });
      const mesh = new THREE.Mesh(PLACEHOLDER_PLANE_GEOMETRY, material);
      return { object3D: mesh, owned: { material } };
    }

    case "video": {
      // Real video texture decoding/display is out of scope for this phase
      // (see VideoNode's own doc comment); this is the same kind of
      // shared-plane-plus-owned-material placeholder the "image" branch
      // above already uses, distinguished only by its fallback color.
      const material = new THREE.MeshBasicMaterial({
        color: VIDEO_PLACEHOLDER_COLOR,
        transparent: true,
      });
      const mesh = new THREE.Mesh(PLACEHOLDER_PLANE_GEOMETRY, material);
      return { object3D: mesh, owned: { material } };
    }

    case "satori": {
      // The real mesh/material/texture are built lazily, in
      // applyNodeProperties, once a SatoriLayerRenderEntry first resolves
      // (mirroring text's own "empty group until ready" fallback) - unlike
      // text, that first resolve is not guaranteed to happen at this node's
      // very first applyNodeProperties call in isolation from frame, since
      // a satori node's own rendered pixels can genuinely vary by frame
      // (elementAnimations), so there is no single "frame 0 only" moment to
      // special-case the way text's own extrudeDepth is. geometry is
      // built once here regardless, since width/height are fixed fields.
      const group = new THREE.Group();
      const geometry = new THREE.PlaneGeometry(node.width, node.height);
      return { object3D: group, owned: { satori: { group, geometry } } };
    }
  }
}

/**
 * Builds a `text` node's `Object3D`: an empty `THREE.Group` if its
 * `TextRenderEntry` is not yet registered (an expected "asset not ready"
 * runtime state, not a programming error - mirrors `image`/`video`'s own
 * placeholder fallback), or the real `Group(line) -> Group(word) ->
 * Mesh(glyph)` hierarchy `buildTextGroup` produces otherwise.
 *
 * Whether to extrude is decided once here, at frame 0: `extrudeDepth` is a
 * `Property<number>` and so *can* be keyframed, but geometry (flat MSDF
 * quads vs. solid `ExtrudeGeometry`) is a structural choice this reconciler
 * only remakes when the node is rebuilt (a new node id, or a kind change),
 * not per frame - the same scope boundary `content`/`fontRef` themselves
 * are already under (changing either on a *persisting* node id without a
 * kind change does not yet trigger a rebuild; this mirrors `image`/`video`
 * still being placeholders rather than a regression this phase introduces).
 */
function buildTextObject(node: TextNode, ctx: NodeFactoryContext): BuiltObject {
  const entry = ctx.textRenderRegistry?.resolve(computeTextNodeRenderKey(node));
  if (entry === undefined) {
    return { object3D: new THREE.Group(), owned: undefined };
  }

  const extrudeDepth = resolveNumberProperty(node.extrudeDepth ?? 0, 0);
  const resources = buildTextGroup(entry.data, {
    color: resolveColorProperty(node.color, 0),
    extrudeDepth,
    font: { bytes: entry.fontBytes, contentHash: entry.fontContentHash },
    // A staggered or physics-animated node needs every glyph's own opacity/
    // position independently settable each frame (apply-text-effects.ts),
    // which the default shared-by-(page,color) materials do not allow; see
    // buildTextGroup's own doc.
    perGlyphMaterial: node.stagger !== undefined || node.physics !== undefined,
  });

  return { object3D: resources.group, owned: { text: resources, textGlyphs: entry.data.glyphs } };
}

/**
 * Applies every property this reconciler derives from `node` onto the
 * already-created `object3D`: transform, visibility, and kind-specific
 * fields. Called on every `reconcile`, even for structurally-unchanged
 * nodes, since property values (color, intensity, fov, ...) may have changed
 * frame to frame without the node's id/kind/hierarchy changing at all.
 *
 * `frame` resolves every `Property<T>` field this reconciler actually reads
 * off `node` to a concrete value for this specific frame: the shared
 * `transform` (`AnimatableTransform`) and `visible` every node kind has, plus
 * kind-specific fields (`camera`'s `fov`/`near`/`far`/`target`, `light`'s
 * `color`/`intensity`, `text`'s `color`), via `resolveNumberProperty`/
 * `resolveVector3Property`/`resolveColorProperty`/`resolveBooleanProperty`. A
 * plain (non-keyframed) property resolves to itself regardless of `frame`,
 * so passing a constant value, as every node did before Phase 26, keeps
 * behaving identically. `text.fontSize` is also `Property<number>` now, but
 * this reconciler does not read it at all yet (real glyph rendering, which
 * would consume it, is still deferred; see the placeholder-plane comment
 * above), so there is nothing to resolve for it here.
 */
export function applyNodeProperties(
  node: SceneNode,
  object3D: THREE.Object3D,
  ctx: NodeFactoryContext,
  frame: number,
  owned?: OwnedResources,
): void {
  applyTransform(node.transform, object3D, frame);
  object3D.visible = resolveBooleanProperty(node.visible, frame);

  switch (node.kind) {
    case "group":
    case "compositionRef":
      return;

    case "mesh": {
      const mesh = object3D as THREE.Mesh;
      mesh.geometry = resolveMeshGeometry(node.geometryRef, ctx.geometryRegistry);
      mesh.material = resolveMeshMaterial(node.materialRef, ctx.materialRegistry);
      return;
    }

    case "camera": {
      const camera = object3D as THREE.PerspectiveCamera;
      camera.fov = resolveNumberProperty(node.fov, frame);
      camera.near = resolveNumberProperty(node.near, frame);
      camera.far = resolveNumberProperty(node.far, frame);
      camera.aspect = 1; // Nothing in this phase's scope sets aspect from anywhere else.
      camera.updateProjectionMatrix();
      const target = resolveVector3Property(node.target, frame);
      camera.lookAt(target[0], target[1], target[2]);
      return;
    }

    case "light": {
      applyLightProperties(node, object3D as THREE.Light, frame);
      return;
    }

    case "text": {
      const color = resolveColorProperty(node.color, frame);
      const fontSize = resolveNumberProperty(node.fontSize, frame);
      // Glyph geometry is built once, in font-size-independent em units (see
      // build-text-group.ts); a fontSize *animating* over time is exactly
      // why this is a per-frame scale multiply here rather than baked into
      // the geometry, which is built only once (or when the resolved
      // render-key/extrusion state changes; see buildTextObject).
      object3D.scale.multiplyScalar(fontSize);
      owned?.text?.setColor(color[0], color[1], color[2], color[3]);
      if ((node.stagger !== undefined || node.physics !== undefined) && owned?.textGlyphs !== undefined) {
        const needsLineTexts = node.stagger?.grouping === "grapheme" || node.physics?.grouping === "grapheme";
        const lineTexts = needsLineTexts ? node.content.split("\n") : undefined;
        applyTextEffects(
          object3D as THREE.Group,
          owned.textGlyphs,
          { stagger: node.stagger, physics: node.physics },
          frame,
          lineTexts,
        );
      }
      return;
    }

    case "image":
      // Fixed placeholder color; assetRef cannot resolve to real image data
      // until Phase 12's asset pipeline exists, so there is nothing to react to.
      return;

    case "video": {
      // Fixed placeholder color, same reason as "image" above (assetRef
      // cannot resolve to a decoded video frame yet; see VideoNode's own
      // doc comment for why real video texture display is out of scope for
      // this phase). opacity is resolved and applied here regardless: it is
      // a genuine Property<number> this phase adds, independent of texture
      // decoding, so there is something real to react to for it even while
      // the frame this placeholder shows is fixed.
      const mesh = object3D as THREE.Mesh;
      (mesh.material as THREE.MeshBasicMaterial).opacity = resolveNumberProperty(
        node.opacity,
        frame,
      );
      return;
    }

    case "satori": {
      applySatoriLayerProperties(node, ctx, frame, owned?.satori);
      return;
    }
  }
}

/**
 * Applies an `@cadra/core` `AnimatableTransform` (Euler-XYZ-radians) onto a
 * Three.js object in place, resolving each of `position`/`rotation`/`scale`
 * (each independently `Property<Vector3>`) to its concrete value at `frame`
 * first via `resolveVector3Property`.
 */
function applyTransform(
  transform: AnimatableTransform,
  object3D: THREE.Object3D,
  frame: number,
): void {
  const position = resolveVector3Property(transform.position, frame);
  object3D.position.set(position[0], position[1], position[2]);
  // Three.js's default Euler order is XYZ, matching the scene graph's fixed convention.
  const rotation = resolveVector3Property(transform.rotation, frame);
  object3D.rotation.set(rotation[0], rotation[1], rotation[2]);
  const scale = resolveVector3Property(transform.scale, frame);
  object3D.scale.set(scale[0], scale[1], scale[2]);
}

function resolveMeshGeometry(ref: string, registry: GeometryRegistry): THREE.BufferGeometry {
  return registry.resolve(ref) ?? DEFAULT_MESH_GEOMETRY;
}

function resolveMeshMaterial(ref: string, registry: MaterialRegistry): THREE.Material {
  return registry.resolve(ref) ?? DEFAULT_MESH_MATERIAL;
}

function createLight(lightType: LightType): THREE.Light {
  switch (lightType) {
    case "ambient":
      return new THREE.AmbientLight();
    case "directional":
      return new THREE.DirectionalLight();
    case "point":
      return new THREE.PointLight();
    case "spot":
      return new THREE.SpotLight();
  }
}

function applyLightProperties(node: LightNode, light: THREE.Light, frame: number): void {
  const color = resolveColorProperty(node.color, frame);
  light.color.setRGB(...colorToRgbTuple(color));
  light.intensity = resolveNumberProperty(node.intensity, frame);
}

/** Converts an `@cadra/core` `ColorRGBA` tuple's RGB channels to a plain 3-tuple for `Color.setRGB`. */
function colorToRgbTuple(
  color: readonly [number, number, number, number],
): [number, number, number] {
  return [color[0], color[1], color[2]];
}

/**
 * Applies this frame's resolved state onto a `satori` node's own owned
 * resources: rebuilds its `mesh`/`material`/`texture` only when
 * `computeSatoriLayerRenderKey` actually changed since the last frame (a
 * static layer, or one whose `elementAnimations` currently hold at a
 * constant value, resolves to the exact same key every frame, so this
 * never rebuilds anything for it), then applies `opacity` and `blendMode`
 * every frame regardless (both are cheap to update in place and, for
 * `opacity`, itself a genuine `Property<number>` independent of whether the
 * underlying pixels changed at all this frame).
 *
 * No-ops entirely when `resources` is `undefined` (this reconciler was not
 * given `satoriLayerRenderRegistry`-owned resources for this node at all,
 * which should not happen for a real `satori` node built by this same
 * module's own `buildThreeObject`, but mirrors this file's existing
 * defensive style elsewhere rather than assuming it).
 */
function applySatoriLayerProperties(
  node: SatoriNode,
  ctx: NodeFactoryContext,
  frame: number,
  resources: SatoriLayerResources | undefined,
): void {
  if (resources === undefined) {
    return;
  }

  const renderKey = computeSatoriLayerRenderKey(node, frame);
  const entry = ctx.satoriLayerRenderRegistry?.resolve(renderKey);
  if (entry !== undefined && resources.lastRenderKey !== renderKey) {
    resources.texture?.dispose();
    resources.material?.dispose();

    const texture = createSvgTexture(entry.rasterized);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
    if (resources.mesh === undefined) {
      resources.mesh = new THREE.Mesh(resources.geometry, material);
      resources.group.add(resources.mesh);
    } else {
      resources.mesh.material = material;
    }
    resources.texture = texture;
    resources.material = material;
    resources.lastRenderKey = renderKey;
  }

  if (resources.material instanceof THREE.MeshBasicMaterial) {
    resources.material.opacity = resolveNumberProperty(node.opacity, frame);
    applySatoriBlendMode(resources.material, node.blendMode);
  }
}

/**
 * Sets a material's Three.js blending mode to match a `SatoriBlendMode`.
 * `'normal'`/`'add'`/`'multiply'` map directly to Three.js's own built-in
 * blending constants; `'screen'` has no built-in equivalent, so it is
 * expressed via `CustomBlending` with explicit factors implementing the
 * real screen-blend formula `result = src + dst - src * dst`: with the
 * `AddEquation` (`result = src * srcFactor + dst * dstFactor`),
 * `srcFactor = 1 - dst` (`OneMinusDstColorFactor`) and `dstFactor = 1`
 * (`OneFactor`) gives `src * (1 - dst) + dst * 1 = src + dst - src * dst`,
 * exactly that formula.
 */
function applySatoriBlendMode(material: THREE.Material, blendMode: SatoriBlendMode | undefined): void {
  switch (blendMode ?? "normal") {
    case "normal":
      material.blending = THREE.NormalBlending;
      return;
    case "add":
      material.blending = THREE.AdditiveBlending;
      return;
    case "multiply":
      material.blending = THREE.MultiplyBlending;
      return;
    case "screen":
      material.blending = THREE.CustomBlending;
      material.blendEquation = THREE.AddEquation;
      material.blendSrc = THREE.OneMinusDstColorFactor;
      material.blendDst = THREE.OneFactor;
      return;
  }
}
