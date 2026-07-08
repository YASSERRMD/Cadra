import {
  type AnimatableTransform,
  type LightNode,
  type LightShadowConfig,
  type LightType,
  type MeshNode,
  resolveBooleanProperty,
  resolveColorProperty,
  type ResolvedMeshMaterial,
  resolveMeshMaterial,
  resolveNumberProperty,
  resolveTextFill,
  resolveTextGlow,
  resolveTextOutline,
  resolveTextShadow,
  resolveVector3Property,
  type SatoriBlendMode,
  type SatoriNode,
  type SceneNode,
  type TextNode,
  toNumericSeed,
  type VolumeNode,
  type VolumeShape,
  type WhiteBalanceGain,
} from "@cadra/core";
import { valueNoise3DTSL } from "@cadra/particles";
import type { PhysicsTransform } from "@cadra/physics";
import type { PositionedGlyph } from "@cadra/text/browser";
import * as THREE from "three";
import { clamp, float, uint, uniform, vec3 } from "three/tsl";
import { type Node, VolumeNodeMaterial } from "three/webgpu";

import { resolveSceneColor } from "../color/resolve-scene-color.js";
import type { RendererBackend } from "../renderer.js";
import { createSvgTexture } from "../svg-layer/create-svg-texture.js";
import {
  computeSatoriLayerRenderKey,
  type SatoriLayerRenderRegistry,
} from "../svg-layer/satori-layer-render-registry.js";
import { applyTextEffects } from "../text/apply-text-effects.js";
import { buildTextGroup, type TextGroupResources } from "../text/build-text-group.js";
import { computeTextNodeRenderKey, type TextRenderRegistry } from "../text/text-render-registry.js";
import type { GeometryRegistry, MaterialRegistry, TextureRegistry } from "./registries.js";

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
  /**
   * Resolves a `MeshMaterialConfig.normalMapRef`/`.aoMapRef` to a real
   * texture. Optional, mirroring `textRenderRegistry`/
   * `satoriLayerRenderRegistry`'s own optionality: omitted means every
   * `normalMapRef`/`aoMapRef` resolves to nothing (a mesh's `normalMap`/
   * `aoMap` simply stay unset), not an error.
   */
  textureRegistry?: TextureRegistry;
  /**
   * The current composition's own white-balance correction gain (see
   * `resolveSceneColor`), mutated in place by `reconciler.ts`'s own
   * `reconcile` at the start of every call rather than fixed once at
   * `createReconciler` time - a composition's own `colorGrading` is not
   * itself frame-dependent (see `Composition.colorGrading`'s own doc), but
   * which composition (and so which grade) a given call is even rendering
   * can differ call to call. Every scene-graph-authored `ColorRGBA` this
   * reconciler resolves into a Three.js color is expected to route through
   * `resolveSceneColor` with this gain, exactly once, rather than being
   * handed to a Three.js color API directly.
   */
  whiteBalanceGain: WhiteBalanceGain;
  /**
   * This frame's own baked physics result (`@cadra/physics`'s own
   * `PhysicsBake.advanceTo`), by node id - only ever populated for a
   * `"dynamic"` `RigidBodyConfig` (see that type's own doc for why
   * `"fixed"`/`"kinematic"` bodies are never in here). Mutated in place by
   * `reconciler.ts`'s own `reconcile` at the start of every call, mirroring
   * `whiteBalanceGain`'s own "fresh per call, not fixed at
   * `createReconciler` time" treatment: which composition (and so which
   * physics bake) a given call is even rendering can differ call to call.
   * `undefined`/omitted means no physics-driven mesh renders any
   * differently than it did before Phase 66.
   */
  physicsTransforms?: ReadonlyMap<string, PhysicsTransform>;
  /**
   * This frame's own resolved particle systems (`@cadra/particles`'s own
   * `ParticleRuntime.resolve`), by node id: the fully-constructed,
   * already-simulated-to-this-frame `THREE.Object3D` each `"particles"` node
   * renders as (a GPU-compute-driven `THREE.Sprite` or a CPU-simulated
   * `THREE.Points`; see that package's own doc for the WebGPU/WebGL2 split).
   * Mutated in place by `reconciler.ts`'s own `reconcile` at the start of
   * every call, mirroring `physicsTransforms`'s own "fresh per call, not
   * fixed at `createReconciler` time" treatment. `undefined`/omitted, or no
   * entry for a given node id, falls back to an empty group (the same
   * "resource not ready yet" placeholder every other node kind's own
   * registry-miss case already uses) - this should not happen in practice,
   * since `ParticleRuntime.resolve` is called against the same tree just
   * before `reconcile`, but mirrors this file's existing defensive style
   * elsewhere rather than assuming it.
   */
  particleObjects?: ReadonlyMap<string, THREE.Object3D>;
  /**
   * This renderer's own resolved backend, mutated in place by
   * `reconciler.ts`'s own `reconcile` at the start of every call, mirroring
   * `whiteBalanceGain`'s own "fresh per call" treatment even though the
   * value itself is fixed for a `ThreeRenderer`'s whole lifetime once
   * `init()` resolves it - `reconcile` has no other way to learn it,
   * since `createReconciler()` is constructed before `init()` ever runs.
   * `undefined` only before `init()` completes, which never happens in
   * practice. Read only by `"volume"` (see that case's own doc for why its
   * technique is WebGPU-only).
   */
  backend?: RendererBackend;
  /**
   * This composition's own frames-per-second, mutated in place by
   * `reconciler.ts`'s own `reconcile` at the start of every call, mirroring
   * `backend`'s own treatment. Read only by `"volume"`, to convert its own
   * `driftSpeed` (authored in units per second, so the same composition
   * looks the same regardless of its own fps) into a per-frame offset.
   */
  fps?: number;
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
   * `node.physics` (Phase 50/51) or `node.path` (Phase 52): that
   * registry-resolved data is only ever on hand inside `buildTextObject`
   * itself, not on every subsequent per-frame call.
   */
  textGlyphs?: readonly PositionedGlyph[];
  /** A `satori` node's own owned resources; see `SatoriLayerResources`'s own doc. */
  satori?: SatoriLayerResources;
  /**
   * A `volume` node's own owned geometry/material (only ever populated on
   * the WebGPU backend; see `"volume"`'s own `buildThreeObject` case doc).
   * Both are per-node (geometry sized to `VolumeNode.shape`, material
   * carrying this node's own `scatteringNode`), never registry-shared.
   */
  volume?: { geometry: THREE.BufferGeometry; material: VolumeNodeMaterial };
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
      const { material, owned } = resolveMeshNodeMaterial(node, ctx);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = node.castShadow ?? false;
      mesh.receiveShadow = node.receiveShadow ?? false;
      return { object3D: mesh, owned };
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

    case "particles":
      // The real object (a GPU-compute-driven THREE.Sprite or a
      // CPU-simulated THREE.Points) is built and owned entirely by
      // @cadra/particles's own ParticleRuntime, not by this reconciler:
      // ownership/disposal already lives there, mirroring how
      // collectPhysicsMeshNodes walks the same tree independently of this
      // reconciler's own walk for Phase 66's physics.
      return { object3D: ctx.particleObjects?.get(node.id) ?? new THREE.Group(), owned: undefined };

    case "volume": {
      // WebGPU-backend only (see VolumeNode's own doc for why): a real
      // raymarched volume needs a genuine THREE.NodeMaterial
      // (VolumeNodeMaterial), which only the WebGPU backend's own node
      // system builds/interprets - a classic WebGLRenderer has nothing to
      // do with a NodeMaterial at all. An empty group is this reconciler's
      // usual "nothing to render yet" fallback (mirroring every other
      // not-ready-yet placeholder here), used for the whole WebGL2 fallback
      // rather than only until some asset resolves.
      if (ctx.backend !== "webgpu") {
        return { object3D: new THREE.Group(), owned: undefined };
      }
      const geometry = buildVolumeGeometry(node.shape);
      const material = buildVolumeMaterial(node);
      const mesh = new THREE.Mesh(geometry, material);
      return { object3D: mesh, owned: { volume: { geometry, material } } };
    }
  }
}

/** The bounding geometry a `VolumeNode`'s own `shape` maps to, centered on the node's own local origin. */
function buildVolumeGeometry(shape: VolumeShape): THREE.BufferGeometry {
  if (shape.type === "box") {
    return new THREE.BoxGeometry(shape.halfExtents[0] * 2, shape.halfExtents[1] * 2, shape.halfExtents[2] * 2);
  }
  return new THREE.SphereGeometry(shape.radius, 24, 16);
}

/**
 * The per-frame-mutable uniform nodes a `volume` node's own `scatteringNode`
 * closes over, stashed in `VolumeNodeMaterial.userData` so `applyVolumeProperties`
 * can update their `.value` every frame without rebuilding the material or
 * its shader graph at all (mirroring `@cadra/particles`'s own GPU compute
 * kernel: build the node graph once, mutate only its uniforms per frame).
 */
interface VolumeUniforms {
  colorR: Node<"float">;
  colorG: Node<"float">;
  colorB: Node<"float">;
  densityMultiplier: Node<"float">;
  drift: Node<"float">;
}

/**
 * Builds a `volume` node's own `VolumeNodeMaterial`: `steps` from
 * `raymarchSteps`, and a `scatteringNode` returning this volume's own
 * (per-frame-mutable) color scaled by its density at that raymarch sample
 * position. Density comes from `@cadra/particles`'s own deterministic
 * scalar value-noise field (not curl noise - a density is a scalar
 * quantity, not a flow direction), remapped from noise's own `[-1, 1)`
 * range to `[0, 1]` and scaled by this volume's own authored density.
 *
 * `color`/`density` (both `Property<T>`) and the drift offset (`frame`-
 * dependent) are not baked in as constants: `applyVolumeProperties` updates
 * their backing uniforms (`VolumeUniforms`, stashed on `material.userData`)
 * every frame, exactly like every other node kind's own per-frame
 * properties, without rebuilding this material or its shader graph.
 */
function buildVolumeMaterial(node: VolumeNode): VolumeNodeMaterial {
  const material = new VolumeNodeMaterial();
  material.steps = node.raymarchSteps ?? 25;

  const numericSeed = uint(toNumericSeed(node.seed ?? 0));
  const frequency = node.noiseFrequency ?? 1;

  const uniforms: VolumeUniforms = {
    colorR: uniform(1, "float") as Node<"float">,
    colorG: uniform(1, "float") as Node<"float">,
    colorB: uniform(1, "float") as Node<"float">,
    densityMultiplier: uniform(1, "float") as Node<"float">,
    drift: uniform(0, "float") as Node<"float">,
  };
  material.userData.volumeUniforms = uniforms;

  material.scatteringNode = ({ positionRay }: { positionRay: Node<"vec3"> }) => {
    const sampleX = positionRay.x.mul(frequency) as Node<"float">;
    const sampleY = positionRay.y.mul(frequency) as Node<"float">;
    const sampleZ = positionRay.z.add(uniforms.drift).mul(frequency) as Node<"float">;
    const noise = valueNoise3DTSL(numericSeed, uint(0), sampleX, sampleY, sampleZ);
    const density = clamp(noise.add(1).mul(0.5), float(0), float(1)).mul(uniforms.densityMultiplier) as Node<
      "float"
    >;
    return vec3(uniforms.colorR, uniforms.colorG, uniforms.colorB).mul(density) as Node<"vec3">;
  };

  return material;
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
 * `fill`/`outline`/`glow`/`shadow` (Phase 53) are *presence* (structural,
 * decided once here, same as `extrudeDepth > 0`) plus *value* (re-resolved
 * every frame in `applyNodeProperties`, same as `color`) - only whether
 * each is configured *at all* is frame-0-only, matching `TextGroupResources`'s
 * own `setFill`/`setOutline`/`setGlow`/`setShadow` each being present only
 * when their config was.
 */
function buildTextObject(node: TextNode, ctx: NodeFactoryContext): BuiltObject {
  const entry = ctx.textRenderRegistry?.resolve(computeTextNodeRenderKey(node, 0));
  if (entry === undefined) {
    return { object3D: new THREE.Group(), owned: undefined };
  }

  const extrudeDepth = resolveNumberProperty(node.extrudeDepth ?? 0, 0);
  const resources = buildTextGroup(entry.data, {
    color: resolveColorProperty(node.color, 0),
    extrudeDepth,
    font: { bytes: entry.fontBytes, contentHash: entry.fontContentHash },
    whiteBalanceGain: ctx.whiteBalanceGain,
    // A staggered or physics-animated node needs every glyph's own opacity/
    // position independently settable each frame (apply-text-effects.ts),
    // which the default shared-by-(page,color) materials do not allow; see
    // buildTextGroup's own doc.
    perGlyphMaterial: node.stagger !== undefined || node.physics !== undefined,
    ...(node.fill !== undefined && { fill: resolveTextFill(node.fill, 0) }),
    ...(node.outline !== undefined && { outline: resolveTextOutline(node.outline, 0) }),
    ...(node.glow !== undefined && { glow: resolveTextGlow(node.glow, 0) }),
    ...(node.shadow !== undefined && { shadow: resolveTextShadow(node.shadow, 0) }),
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
      if (node.material !== undefined && owned?.material instanceof THREE.MeshPhysicalMaterial) {
        // Mutates the same owned material in place rather than reconstructing
        // it, so its identity (and any GPU-side compiled shader variant)
        // stays stable frame to frame; see resolveMeshNodeMaterial/
        // applyPbrMaterial's own doc.
        applyPbrMaterial(owned.material, resolveMeshMaterial(node.material, frame), ctx);
        mesh.material = owned.material;
      } else {
        mesh.material = resolveMeshMaterialRef(node.materialRef, ctx.materialRegistry);
      }
      mesh.castShadow = node.castShadow ?? false;
      mesh.receiveShadow = node.receiveShadow ?? false;
      applyPhysicsTransform(node, object3D, ctx);
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
      applyLightProperties(node, object3D as THREE.Light, frame, ctx.whiteBalanceGain);
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
      if (node.fill !== undefined) {
        owned?.text?.setFill?.(resolveTextFill(node.fill, frame));
      }
      if (node.outline !== undefined) {
        owned?.text?.setOutline?.(resolveTextOutline(node.outline, frame));
      }
      if (node.glow !== undefined) {
        owned?.text?.setGlow?.(resolveTextGlow(node.glow, frame));
      }
      if (node.shadow !== undefined) {
        owned?.text?.setShadow?.(resolveTextShadow(node.shadow, frame));
      }
      if (
        (node.stagger !== undefined || node.physics !== undefined || node.path !== undefined) &&
        owned?.textGlyphs !== undefined
      ) {
        const needsLineTexts = node.stagger?.grouping === "grapheme" || node.physics?.grouping === "grapheme";
        const lineTexts = needsLineTexts ? node.content.split("\n") : undefined;
        applyTextEffects(
          object3D as THREE.Group,
          owned.textGlyphs,
          { stagger: node.stagger, physics: node.physics, path: node.path },
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

    case "particles":
      // Nothing to do here: ctx.particleObjects already reflects this exact
      // frame's simulated state (position/color/size buffers), advanced by
      // ThreeRenderer before reconcile runs at all; only the shared
      // transform/visible prefix above (this node's own authored pose)
      // applies to a particles node.
      return;

    case "volume": {
      applyVolumeProperties(node, owned?.volume?.material, frame, ctx);
      return;
    }
  }
}

/**
 * Applies this frame's resolved `color`/`density` and drift offset onto a
 * `volume` node's own `VolumeNodeMaterial`, by mutating its `VolumeUniforms`'
 * own `.value`s (see `buildVolumeMaterial`'s own doc) - never rebuilding the
 * material or its `scatteringNode` shader graph. A no-op when `material` is
 * `undefined` (the WebGL2 fallback, which never builds one at all - see
 * `"volume"`'s own `buildThreeObject` case).
 */
function applyVolumeProperties(
  node: VolumeNode,
  material: VolumeNodeMaterial | undefined,
  frame: number,
  ctx: NodeFactoryContext,
): void {
  const uniforms = material?.userData.volumeUniforms as VolumeUniforms | undefined;
  if (uniforms === undefined) {
    return;
  }

  const [r, g, b, a] = resolveSceneColor(resolveColorProperty(node.color, frame), ctx.whiteBalanceGain);
  const density = resolveNumberProperty(node.density, frame) * a;
  const fps = ctx.fps ?? 30;
  const drift = (node.driftSpeed ?? 0) * (frame / fps);

  setUniformValue(uniforms.colorR, r);
  setUniformValue(uniforms.colorG, g);
  setUniformValue(uniforms.colorB, b);
  setUniformValue(uniforms.densityMultiplier, density);
  setUniformValue(uniforms.drift, drift);
}

/**
 * Mutates a TSL `uniform(...)` node's own `.value` in place - `Node<"float">`
 * (this module's own TSL type alias, matching `@cadra/particles`'s own
 * `ComputeDispatchable` convention) does not itself declare `.value`, since
 * a plain `Node` might be a `ConstNode` (baked in at shader-compile time,
 * genuinely immutable) instead. Every node this function is ever called
 * with is one `buildVolumeMaterial` constructed via `uniform(...)`
 * specifically (never `float(...)`, which returns a `ConstNode`), so this
 * cast is sound in context: `UniformNode`'s own `.value` is a real, mutable
 * runtime property (verified against this project's installed
 * `three@0.185.1` source, `nodes/core/InputNode.js`), just not one
 * `@types/three` exposes on the generic `Node` base type `uniform(...)`
 * itself is typed as returning.
 */
function setUniformValue(node: Node<"float">, value: number): void {
  (node as unknown as { value: number }).value = value;
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

/**
 * Overrides `object3D`'s own position/rotation (already set by `applyTransform`
 * above, from `node.transform`) with this frame's own baked physics result,
 * when `node` has a `"dynamic"` `rigidBody`: physics owns a dynamic body's
 * pose from frame 0 onward (see `RigidBodyConfig`'s own doc, `@cadra/core`),
 * so its own authored `transform` is only ever this body's *initial* pose,
 * superseded here for every frame physics actually reports a result for.
 * A no-op for every other mesh (no `rigidBody`, or `"fixed"`/`"kinematic"`,
 * neither of which `ctx.physicsTransforms` ever contains an entry for - see
 * `PhysicsBake.advanceTo`'s own doc in `@cadra/physics`), or if physics has
 * not resolved a pose for this exact node id (e.g. this composition's own
 * `sceneState.physics` is unset and nothing in it uses `rigidBody` at all).
 */
function applyPhysicsTransform(node: MeshNode, object3D: THREE.Object3D, ctx: NodeFactoryContext): void {
  if (node.rigidBody?.bodyType !== "dynamic") {
    return;
  }
  const baked = ctx.physicsTransforms?.get(node.id);
  if (baked === undefined) {
    return;
  }
  object3D.position.set(baked.position[0], baked.position[1], baked.position[2]);
  object3D.rotation.set(baked.rotation[0], baked.rotation[1], baked.rotation[2]);
}

function resolveMeshGeometry(ref: string, registry: GeometryRegistry): THREE.BufferGeometry {
  return registry.resolve(ref) ?? DEFAULT_MESH_GEOMETRY;
}

function resolveMeshMaterialRef(ref: string, registry: MaterialRegistry): THREE.Material {
  return registry.resolve(ref) ?? DEFAULT_MESH_MATERIAL;
}

/**
 * Decides what `THREE.Material` a `mesh` node's own geometry mounts on, and
 * what (if anything) the reconciler comes to own as a result: `node.material`
 * (a `MeshMaterialConfig`), when present, takes over entirely from
 * `materialRef` and gets a freshly constructed, per-node `MeshPhysicalMaterial`
 * that only this node's own entry owns (tracked so `disposeEntry` in
 * `reconciler.ts` disposes it, exactly like `image`/`video`'s own per-node
 * placeholder material already is - never a shared/pooled registry instance).
 * Otherwise, falls back to `materialRef`'s registry-resolved (possibly
 * shared/pooled) material, owning nothing, the exact pre-Phase-55 behavior.
 */
function resolveMeshNodeMaterial(
  node: MeshNode,
  ctx: NodeFactoryContext,
): { material: THREE.Material; owned: OwnedResources | undefined } {
  if (node.material === undefined) {
    return { material: resolveMeshMaterialRef(node.materialRef, ctx.materialRegistry), owned: undefined };
  }
  const material = buildPbrMaterial(resolveMeshMaterial(node.material, 0), ctx);
  return { material, owned: { material } };
}

/** Constructs a fresh `MeshPhysicalMaterial` from a frame-0 resolved `MeshMaterialConfig`; see `resolveMeshNodeMaterial`. */
function buildPbrMaterial(resolved: ResolvedMeshMaterial, ctx: NodeFactoryContext): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial();
  applyPbrMaterial(material, resolved, ctx);
  return material;
}

/**
 * Applies a resolved `MeshMaterialConfig` onto an existing `MeshPhysicalMaterial`
 * in place (never reconstructs it), mirroring how `applyLightProperties`
 * mutates an existing `THREE.Light` every frame rather than rebuilding it.
 * `baseColor`/`emissive` route through `resolveSceneColor` (this renderer's
 * one designated sRGB-to-linear conversion point), exactly like a light's own
 * `color` already does.
 */
function applyPbrMaterial(
  material: THREE.MeshPhysicalMaterial,
  resolved: ResolvedMeshMaterial,
  ctx: NodeFactoryContext,
): void {
  const [r, g, b, a] = resolveSceneColor(resolved.baseColor, ctx.whiteBalanceGain);
  material.color.setRGB(r, g, b);
  const opacity = resolved.opacity * a;
  const wasTransparent = material.transparent;
  material.opacity = opacity;
  material.transparent = opacity < 1;

  material.metalness = resolved.metalness;
  material.roughness = resolved.roughness;

  const [er, eg, eb] = resolveSceneColor(resolved.emissive, ctx.whiteBalanceGain);
  material.emissive.setRGB(er, eg, eb);
  material.emissiveIntensity = resolved.emissiveIntensity;

  material.clearcoat = resolved.clearcoat;
  material.clearcoatRoughness = resolved.clearcoatRoughness;

  // transmission/sheen need no needsUpdate dance, exactly like clearcoat
  // above: Three.js's own MeshPhysicalMaterial setters bump the material's
  // version when either crosses the zero threshold, and WebGLRenderer's
  // getProgram() recomputes its shader-variant cache key from live material
  // state on every render call (verified against this project's installed
  // three@0.185.1 source, MeshPhysicalMaterial.js and WebGLPrograms.js) -
  // the same live-detection path already relied on for clearcoat.
  material.transmission = resolved.transmission;
  material.ior = resolved.ior;
  material.thickness = resolved.thickness;

  material.sheen = resolved.sheen;
  material.sheenRoughness = resolved.sheenRoughness;
  const [shr, shg, shb] = resolveSceneColor(resolved.sheenColor, ctx.whiteBalanceGain);
  material.sheenColor.setRGB(shr, shg, shb);

  const normalMap =
    resolved.normalMapRef !== undefined ? (ctx.textureRegistry?.resolve(resolved.normalMapRef) ?? null) : null;
  const aoMap = resolved.aoMapRef !== undefined ? (ctx.textureRegistry?.resolve(resolved.aoMapRef) ?? null) : null;
  // Assigning a new map reference (even the same one again) needs
  // material.needsUpdate for Three.js to recompile the right shader defines;
  // gated on an actual identity change (or the transparent flag flipping) so
  // an unrelated per-frame update (color, metalness, ...) never pays for a
  // shader recompile it does not need.
  const structuralChange =
    material.normalMap !== normalMap || material.aoMap !== aoMap || wasTransparent !== material.transparent;
  material.normalMap = normalMap;
  material.aoMap = aoMap;
  if (structuralChange) {
    material.needsUpdate = true;
  }
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
    case "area":
      return new THREE.RectAreaLight();
  }
}

function applyLightProperties(
  node: LightNode,
  light: THREE.Light,
  frame: number,
  whiteBalanceGain: WhiteBalanceGain,
): void {
  const color = resolveColorProperty(node.color, frame);
  const [r, g, b] = resolveSceneColor(color, whiteBalanceGain);
  // No color-space argument: resolveSceneColor's own output is already in
  // this renderer's linear working space, not sRGB-encoded.
  light.color.setRGB(r, g, b);
  light.intensity = resolveNumberProperty(node.intensity, frame);

  // Harmless no-op for lightType "area": Three.js's RectAreaLight has no
  // shadow support at all (see LightNode.castShadow's own doc).
  light.castShadow = node.castShadow ?? false;
  if (light.castShadow) {
    applyLightShadowConfig(light, node.shadow);
  }

  if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
    if (node.distance !== undefined) {
      light.distance = node.distance;
    }
    if (node.decay !== undefined) {
      light.decay = node.decay;
    }
  }
  if (light instanceof THREE.SpotLight) {
    if (node.angle !== undefined) {
      light.angle = node.angle;
    }
    if (node.penumbra !== undefined) {
      light.penumbra = node.penumbra;
    }
  }
  if (light instanceof THREE.RectAreaLight) {
    if (node.width !== undefined) {
      light.width = node.width;
    }
    if (node.height !== undefined) {
      light.height = node.height;
    }
  }
}

/**
 * Applies `LightShadowConfig` tuning onto whichever `THREE.Light` subclass
 * actually owns a `.shadow` object (`DirectionalLight`/`PointLight`/
 * `SpotLight`; `AmbientLight`/`RectAreaLight` have none at all - see each
 * one's own `@types/three` declaration). A no-op for those two, matching
 * `castShadow`'s own harmless-no-op precedent for `RectAreaLight` above.
 */
function applyLightShadowConfig(light: THREE.Light, shadow: LightShadowConfig | undefined): void {
  if (
    !(
      light instanceof THREE.DirectionalLight ||
      light instanceof THREE.PointLight ||
      light instanceof THREE.SpotLight
    )
  ) {
    return;
  }
  if (shadow?.mapSize !== undefined) {
    light.shadow.mapSize.set(shadow.mapSize, shadow.mapSize);
  }
  if (shadow?.bias !== undefined) {
    light.shadow.bias = shadow.bias;
  }
  if (shadow?.radius !== undefined) {
    light.shadow.radius = shadow.radius;
  }
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
