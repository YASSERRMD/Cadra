import {
  type AnimatableTransform,
  type ImageNode,
  type LightNode,
  type LightShadowConfig,
  type LightType,
  type MeshGeometryConfig,
  type MeshNode,
  type ModelNode,
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
  type SatoriNode,
  type SceneNode,
  type TextNode,
  toNumericSeed,
  type VideoBlendMode,
  type VideoNode,
  type VolumeNode,
  type VolumeShape,
  type WhiteBalanceGain,
} from "@cadra/core";
import { valueNoise3DTSL } from "@cadra/particles";
import type { PhysicsTransform } from "@cadra/physics";
import type { PositionedGlyph } from "@cadra/text/browser";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { clamp, float, uint, uniform, vec3 } from "three/tsl";
import { type Node, VolumeNodeMaterial } from "three/webgpu";

import type { LoadedModel, ModelRegistry } from "../assets/model-registry.js";
import { resolveSceneColor } from "../color/resolve-scene-color.js";
import type { RendererBackend } from "../renderer.js";
import { createSvgTexture } from "../svg-layer/create-svg-texture.js";
import {
  computeSatoriLayerRenderKey,
  type SatoriLayerRenderRegistry,
} from "../svg-layer/satori-layer-render-registry.js";
import { applyTextEffects, applyTextMorph } from "../text/apply-text-effects.js";
import { buildTextGroup, disposeTextGroupResources, type TextGroupResources } from "../text/build-text-group.js";
import { computeTextNodeRenderKey, type TextRenderRegistry } from "../text/text-render-registry.js";
import {
  computeVideoFrameRenderKey,
  type VideoFrameRegistry,
} from "../video-layer/video-frame-registry.js";
import type { GeometryRegistry, MaterialRegistry, TextureRegistry } from "./registries.js";
import { createDataTexture, createImageTexture } from "./registries.js";

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
   * looks the same regardless of its own fps) into a per-frame offset. Also
   * read by `"model"`, to convert each active `ModelClipConfig`'s own
   * `timeScale` (also authored in a real-time unit, seconds) into a
   * per-frame clip-local time.
   */
  fps?: number;
  /**
   * This composition's own `width / height`, mutated in place by
   * `reconciler.ts`'s own `reconcile` at the start of every call, mirroring
   * `fps`'s own treatment. Read only by `"camera"`, to set `camera.aspect`
   * so its projection matches the composition's actual pixel dimensions
   * instead of assuming a square frame. `undefined` falls back to `1`
   * (square), matching every camera's behavior before this field existed.
   */
  aspect?: number;
  /**
   * This render's own base seed (`FrameContext.seed`), mutated in place by
   * `reconciler.ts`'s own `reconcile` at the start of every call, mirroring
   * `fps`'s own treatment. Read only by `"volume"`, combined with the node's
   * own `id` and `VolumeNode.seed` (see that field's own doc) into the
   * numeric seed its noise field is built from - `undefined` falls back to
   * `0`, contributing nothing (a volume's own `id`/`seed` alone still
   * determine its noise field, same as before this field existed).
   */
  seed?: string | number;
  /**
   * Resolves a `ModelNode.assetRef` to its already-loaded `LoadedModel`.
   * Optional, mirroring `textRenderRegistry`/`satoriLayerRenderRegistry`'s
   * own optionality: omitted, or no entry for a given `assetRef`, falls
   * back to an empty group (the same "resource not ready yet" placeholder
   * every other node kind's own registry-miss case already uses).
   */
  modelRegistry?: ModelRegistry;
  /**
   * Resolves a `VideoNode` at a specific frame (via
   * `computeVideoFrameRenderKey`) to its already-decoded current-frame
   * pixels. Optional, mirroring `satoriLayerRenderRegistry`'s own
   * optionality: omitted, or no entry for a given node/frame, falls back
   * to the documented `video` placeholder plane (the same "resource not
   * ready yet" contract every other registry-resolved node kind already
   * has).
   */
  videoFrameRegistry?: VideoFrameRegistry;
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
  /**
   * A `morph`-configured `text` node's own second glyph group, rendering
   * `node.morph.from` - kept as a fully separate `TextGroupResources` (its
   * own geometries/materials/textures, disposed alongside `text`'s own
   * above) rather than merged into it, so `applyTextMorph`'s own
   * `getObjectByName` lookups can never collide between a "from" glyph and
   * a "to" glyph sharing the same `cluster`/`glyphId` - see
   * `buildTextObject`'s own doc. `fromGlyphs` mirrors `textGlyphs` above,
   * just for this second group. `undefined` whenever `node.morph` is
   * absent, exactly like `text`/`textGlyphs` are `undefined` before any
   * `TextRenderEntry` is registered.
   */
  textMorph?: { from: TextGroupResources; fromGlyphs: readonly PositionedGlyph[] };
  /**
   * The `computeTextNodeRenderKey` this node's current `text`/`textGlyphs`/
   * `textMorph` were last built from, mirroring `SatoriLayerResources.lastRenderKey`/
   * `OwnedResources.video.lastRenderKey`'s own identical field: content is
   * rebuilt only when a frame actually resolves to a different key (most
   * often because a keyframed `variationAxes` resolves a genuinely
   * different instance - see that field's own doc), not on every single
   * `applyNodeProperties` call. `undefined` until the very first successful
   * resolve, exactly like `text` itself.
   */
  textLastRenderKey?: string;
  /** A `satori` node's own owned resources; see `SatoriLayerResources`'s own doc. */
  satori?: SatoriLayerResources;
  /**
   * A `volume` node's own owned geometry/material (only ever populated on
   * the WebGPU backend; see `"volume"`'s own `buildThreeObject` case doc).
   * Both are per-node (geometry sized to `VolumeNode.shape`, material
   * carrying this node's own `scatteringNode`), never registry-shared.
   */
  volume?: { geometry: THREE.BufferGeometry; material: VolumeNodeMaterial };
  /**
   * A `model` node's own owned per-instance state: everything unique to
   * this reconciled clone of a shared `LoadedModel` registry entry, as
   * opposed to the entry's own geometries/materials/textures (shared with
   * every other instance and the registry's own cached template, via
   * `SkeletonUtils.clone`'s "clone the hierarchy, reuse the leaf
   * resources" behavior - see `"model"`'s own `buildThreeObject` case doc
   * for why disposing them here would be wrong). `undefined` while this
   * node's own `assetRef` has not resolved yet (an empty placeholder
   * `THREE.Group`, no cloned hierarchy grafted into it yet); mirrors
   * `OwnedResources.image`'s own identical "presence means resolved"
   * convention, retried by `applyNodeProperties`'s own `"model"` case on
   * any later reconcile while still `undefined` - see that case's own doc.
   */
  model?: ModelOwnedResources;
  /**
   * An `image` node's own geometry, sized to its resolved texture's own
   * aspect ratio (a plane 1 unit wide, `naturalHeight / naturalWidth`
   * units tall - an author scales the node's own `transform.scale` for a
   * specific final size). Only populated once `ctx.textureRegistry`
   * actually resolves this node's `assetRef`; the material for both the
   * resolved and not-yet-resolved-placeholder cases alike has always lived
   * in `OwnedResources.material` above. `undefined` (no per-node geometry
   * to dispose) while still on the shared `PLACEHOLDER_PLANE_GEOMETRY`.
   */
  image?: { geometry: THREE.BufferGeometry };
  /**
   * A `video` node's own geometry, sized to its currently-resolved frame's
   * own aspect ratio - the exact same convention `OwnedResources.image`
   * documents, applied per-frame instead of once, since a video's own
   * resolved content (and so its own natural aspect ratio) can genuinely
   * change frame to frame. `texture` is the `THREE.Texture` `createImageTexture`
   * wraps around `videoFrameRegistry`'s own resolved `ImageBitmap` -
   * unlike `TextureRegistry` (which hands the reconciler an
   * already-wrapped, registry-owned `THREE.Texture` directly, see
   * `OwnedResources.image`'s own doc for why that one is never disposed
   * here), `VideoFrameRegistry` only ever hands back raw decoded pixels
   * (see `VideoFrameRenderEntry`'s own doc): the *wrapping* `THREE.Texture`
   * is created fresh, inside `applyVideoNodeProperties`, on every render
   * key change, and so is genuinely reconciler-owned and must be disposed
   * like any other owned resource - both on the next swap and on final
   * teardown (`disposeEntry`). `lastRenderKey` is the
   * `computeVideoFrameRenderKey` this node's current
   * `mesh.geometry`/`mesh.material`/`texture` were last built from,
   * mirroring `SatoriLayerResources`'s own identical field: rebuilt only
   * when a new frame actually resolves to a different key, not on every
   * single `applyNodeProperties` call. `undefined` (no per-node geometry
   * to dispose) while still on the shared `PLACEHOLDER_PLANE_GEOMETRY`.
   */
  video?: { geometry: THREE.BufferGeometry; texture: THREE.Texture; lastRenderKey: string };
  /**
   * A `mesh` node's own procedurally built geometry, populated only when
   * `MeshNode.geometry` is set (see `resolveMeshNodeGeometry`'s own doc):
   * unlike `geometryRef`'s registry-resolved geometry (pooled, shared, never
   * disposed here - see `GeometryRegistry`'s own doc), a `new THREE.*Geometry(...)`
   * built from an inline `MeshGeometryConfig` is unique to this one node and
   * must be disposed like any other owned resource, both on the next rebuild
   * (a different `geometry` config, `geometryKey` mismatches) and on final
   * teardown (`disposeEntry`). `geometryKey` is a `JSON.stringify` of the
   * `MeshGeometryConfig` this node's current `geometry` was last built from,
   * mirroring `OwnedResources.video`'s own `lastRenderKey` field: rebuilt
   * only when the config actually changes, not on every single
   * `applyNodeProperties` call.
   */
  meshGeometry?: { geometry: THREE.BufferGeometry; geometryKey: string };
}

/**
 * A `model` node's own owned per-instance state (see `OwnedResources.model`'s
 * own doc for why this is its own type rather than inlined there): one
 * `THREE.AnimationMixer` built against this instance's own cloned root, one
 * `THREE.AnimationAction` per clip the loaded asset has (by clip name,
 * pre-built once so `applyNodeProperties` never rebuilds one just to mute or
 * re-enable it - only ever mutates `.time`/`.weight` on an already-built
 * action), every cloned `THREE.SkinnedMesh`'s own cloned `Skeleton` (each
 * one's `boneTexture`, lazily allocated real GPU memory, needs its own
 * explicit `.dispose()` - see `disposeEntry` in `reconciler.ts`), and every
 * morph-target-capable mesh in this instance's own hierarchy (collected once
 * here rather than re-traversed every `applyNodeProperties` call).
 */
interface ModelOwnedResources {
  mixer: THREE.AnimationMixer;
  actions: ReadonlyMap<string, THREE.AnimationAction>;
  skeletons: readonly THREE.Skeleton[];
  morphMeshes: readonly THREE.Mesh[];
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
      const { geometry, owned: geometryOwned } = resolveMeshNodeGeometry(node, ctx);
      const { material, owned: materialOwned } = resolveMeshNodeMaterial(node, ctx);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = node.castShadow ?? false;
      mesh.receiveShadow = node.receiveShadow ?? false;
      const owned =
        geometryOwned !== undefined || materialOwned !== undefined
          ? { ...geometryOwned, ...materialOwned }
          : undefined;
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
      return buildTextObject();

    case "image":
      return buildImageObject(node, ctx);

    case "video": {
      // Unlike "image" above, a video node's real content depends on frame
      // (which this function - called once, at build time, before any
      // frame is resolved - never receives), so there is no build-time
      // equivalent of buildImageObject's immediate resolve here. This
      // always starts as the same kind of shared-plane-plus-owned-material
      // placeholder the "image" branch uses (distinguished only by its
      // fallback color), and applyVideoNodeProperties (mirroring
      // applySatoriLayerProperties's own identical "frame-dependent content
      // resolves lazily" reasoning) swaps in the real decoded frame once
      // ctx.videoFrameRegistry first resolves one for it.
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
      const material = buildVolumeMaterial(node, ctx);
      const mesh = new THREE.Mesh(geometry, material);
      return { object3D: mesh, owned: { volume: { geometry, material } } };
    }

    case "model": {
      const entry = ctx.modelRegistry?.resolve(node.assetRef);
      if (entry === undefined) {
        // A real (if empty) `owned`, not `undefined`: `applyNodeProperties`'s
        // own `"model"` case needs a mutable object to later populate with
        // `owned.model` once a caller whose own registry populates
        // asynchronously (see `apps/studio`'s own live viewport) resolves
        // this node's `assetRef` on a later reconcile - see that case's own
        // doc, and `OwnedResources.model`'s own doc for the exact contract.
        return { object3D: new THREE.Group(), owned: {} };
      }
      return buildModelObject(node, entry);
    }
  }
}

/**
 * Builds a `model` node's own reconciled instance from an already-loaded
 * `LoadedModel`: clones its scene (`SkeletonUtils.clone`, not a plain
 * `Object3D.clone()` - the latter would leave every `SkinnedMesh` bound to
 * the registry entry's own shared `Skeleton`/bones, so every reconciled
 * instance of the same asset would visibly share one pose instead of
 * animating independently; `SkeletonUtils.clone` gives each clone its own
 * independent skeleton, correctly rebound, and is also safe to call on a
 * model with no skinning at all - its own skeleton-specific rebinding step
 * simply finds nothing to do), applies `castShadow`/`receiveShadow` to
 * every mesh in the cloned hierarchy (a `ModelNode` has no per-submesh
 * override, mirroring `MeshNode`'s own single flag applied to its one
 * mesh), and pre-builds one `THREE.AnimationAction` per clip the asset has
 * (regardless of whether `ModelNode.clips` currently references it - see
 * `applyModelProperties`'s own doc for why).
 */
function buildModelObject(node: ModelNode, entry: LoadedModel): BuiltObject {
  const cloned = cloneSkinned(entry.scene);

  const skeletons: THREE.Skeleton[] = [];
  const morphMeshes: THREE.Mesh[] = [];
  cloned.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    child.castShadow = node.castShadow ?? false;
    child.receiveShadow = node.receiveShadow ?? false;
    if (child instanceof THREE.SkinnedMesh) {
      skeletons.push(child.skeleton);
    }
    if (child.morphTargetDictionary !== undefined && child.morphTargetInfluences !== undefined) {
      morphMeshes.push(child);
    }
  });

  const mixer = new THREE.AnimationMixer(cloned);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of entry.animations) {
    const action = mixer.clipAction(clip);
    // Enrolls this action in the mixer's own active-update list; every
    // per-frame pose comes from applyModelProperties directly setting
    // .time/.weight below and calling mixer.update(0), never from this
    // action's own time accumulating on its own.
    action.play();
    action.weight = 0;
    actions.set(clip.name, action);
  }

  return { object3D: cloned, owned: { model: { mixer, actions, skeletons, morphMeshes } } };
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
 *
 * `numericSeed` combines `ctx.seed` (this render's own base seed),
 * `node.id`, and `node.seed` into one value, exactly matching
 * `VolumeNode.seed`'s own documented contract ("combined with the
 * composition's own frame seed and this node's own `id`") - mirroring
 * `@cadra/particles`' own identical `ParticleSystemNode.seed` combination
 * (`toNumericSeed(\`${node.id}:${node.seed}\`)`, in `particle-runtime.ts`),
 * folded into one `toNumericSeed` call here since `valueNoise3DTSL` (unlike
 * `particleHash`) takes only one seed-shaped argument, not a separate
 * composition/emitter pair.
 */
function buildVolumeMaterial(node: VolumeNode, ctx: NodeFactoryContext): VolumeNodeMaterial {
  const material = new VolumeNodeMaterial();
  material.steps = node.raymarchSteps ?? 25;

  const resolvedNumericSeed = toNumericSeed(`${ctx.seed ?? 0}:${node.id}:${node.seed ?? 0}`);
  const numericSeed = uint(resolvedNumericSeed);
  const frequency = node.noiseFrequency ?? 1;

  const uniforms: VolumeUniforms = {
    colorR: uniform(1, "float") as Node<"float">,
    colorG: uniform(1, "float") as Node<"float">,
    colorB: uniform(1, "float") as Node<"float">,
    densityMultiplier: uniform(1, "float") as Node<"float">,
    drift: uniform(0, "float") as Node<"float">,
  };
  material.userData.volumeUniforms = uniforms;
  // Not consulted by anything else this material's own construction needs -
  // stashed purely so a test can verify the resolved value without reaching
  // into scatteringNode's own closure, mirroring volumeUniforms' own "stash
  // on userData for test introspection" precedent immediately above.
  material.userData.volumeNumericSeed = resolvedNumericSeed;

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
 * Builds the geometry/material pair a resolved `image` texture renders
 * with: a plane sized to the texture's own natural aspect ratio - 1 unit
 * wide, `naturalHeight / naturalWidth` units tall - so a non-square image
 * renders at its own true proportions rather than stretched into a square;
 * an author wanting a specific final size scales the node's own
 * `transform.scale`, exactly like every other node kind's own size
 * convention. `ImageNode` has no `width`/`height` field of its own to size
 * from instead (see its own doc in `@cadra/core`).
 *
 * Shared between `buildImageObject` (the initial reconcile) and
 * `applyNodeProperties`'s own `"image"` case (a later reconcile that
 * finds `ctx.textureRegistry` now resolves an `assetRef` it did not
 * before - see that case's own doc for why a *second* call site needs
 * this exact same construction).
 */
function buildResolvedImageMesh(
  texture: THREE.Texture,
): { geometry: THREE.PlaneGeometry; material: THREE.MeshBasicMaterial } {
  const naturalWidth: number | undefined = (texture.image as { width?: number } | undefined)?.width;
  const naturalHeight: number | undefined = (texture.image as { height?: number } | undefined)?.height;
  const aspect =
    naturalWidth !== undefined && naturalHeight !== undefined && naturalHeight > 0
      ? naturalWidth / naturalHeight
      : 1;
  const geometry = new THREE.PlaneGeometry(1, 1 / aspect);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
  return { geometry, material };
}

/**
 * Builds an `image` node's `Object3D`: a real textured plane when
 * `ctx.textureRegistry` resolves `node.assetRef`, or the documented gray
 * placeholder plane otherwise (no registry injected at all, or this
 * specific `assetRef` not yet loaded - the same "not yet loaded is an
 * expected runtime state, not a programming error" contract every other
 * registry-resolved node kind in this file already follows; a caller
 * whose own registry populates asynchronously, after this node's own
 * first reconcile - see `apps/studio`'s own live, progressively-loading
 * viewport - gets a real, non-placeholder plane on a later reconcile
 * instead, via `applyNodeProperties`'s own `"image"` case retry).
 */
function buildImageObject(node: ImageNode, ctx: NodeFactoryContext): BuiltObject {
  const texture = ctx.textureRegistry?.resolve(node.assetRef);
  if (texture === undefined) {
    const material = new THREE.MeshBasicMaterial({ color: IMAGE_PLACEHOLDER_COLOR });
    const mesh = new THREE.Mesh(PLACEHOLDER_PLANE_GEOMETRY, material);
    return { object3D: mesh, owned: { material } };
  }

  const { geometry, material } = buildResolvedImageMesh(texture);
  const mesh = new THREE.Mesh(geometry, material);
  return { object3D: mesh, owned: { material, image: { geometry } } };
}

/**
 * Builds a `text` node's starting `Object3D`: always an empty, otherwise
 * inert `THREE.Group` with no owned content yet. Unlike most kinds, a text
 * node's real render key can genuinely vary by frame (`variationAxes` may
 * be keyframed - see `computeTextNodeRenderKey`'s own doc), which this
 * function - called once, at build time, before any frame is resolved -
 * never receives; mirrors `"video"`'s own identical "frame-dependent
 * content resolves lazily" reasoning (see that case's own doc above).
 * `applyNodeProperties` (which does receive `frame`) builds the real
 * content into this group via `buildTextContent` below, on its own first
 * call and again on any later render-key change.
 */
function buildTextObject(): BuiltObject {
  return { object3D: new THREE.Group(), owned: {} };
}

/** What `buildTextContent` returns when it successfully resolves `node`'s content at a given frame - everything the caller needs to swap into the scene graph and record onto `OwnedResources`. */
interface TextContentBuild {
  renderKey: string;
  text: TextGroupResources;
  textGlyphs: readonly PositionedGlyph[];
  textMorph?: { from: TextGroupResources; fromGlyphs: readonly PositionedGlyph[] };
}

/**
 * Builds the real `Group(line) -> Group(word) -> Mesh(glyph)` hierarchy
 * (hierarchies, for a `morph`-configured node - see below) for `node` at
 * `frame`, from whatever `ctx.textRenderRegistry` already has registered.
 * `undefined` when the primary content's own `TextRenderEntry` is not yet
 * registered - an expected "asset not ready" runtime state, not a
 * programming error, mirroring `image`/`video`'s own placeholder fallback;
 * the caller (`applyNodeProperties`'s `"text"` case) leaves whatever was
 * previously built (if anything) in place rather than tearing it down over
 * a transient miss.
 *
 * Called both from `applyNodeProperties`'s own first `"text"` call for a
 * node (there is nothing to render until this succeeds at least once) and
 * again on any later render-key change - most often a keyframed
 * `variationAxes` resolving a genuinely different instance at `frame`, but
 * structurally any `computeTextNodeRenderKey` change. Whether to extrude,
 * and whether `fill`/`outline`/`glow`/`shadow` are configured *at all*
 * (their *value*, unlike their presence, is re-resolved every frame
 * unconditionally in `applyNodeProperties`, same as `color`) are decided
 * fresh on each such call, matching `TextGroupResources`'s own
 * `setFill`/`setOutline`/`setGlow`/`setShadow` each being present only when
 * their config was.
 *
 * A `node.morph` config builds a *second* `TextGroupResources` from
 * `node.morph.from` (via a synthetic `{...node, content: node.morph.from}`
 * render key - the same font/style, just different text), returned
 * alongside the primary one rather than merged into one: `applyTextMorph`'s
 * own `getObjectByName` lookups can never collide between a "from" glyph
 * and a "to" glyph that happen to share the same `cluster`/`glyphId` (e.g.
 * a letter common to both strings) as long as the two stay structurally
 * separate `THREE.Group` subtrees - see that function's own doc. Omitted
 * when the "from" text's own `TextRenderEntry` is not yet registered - the
 * primary content still renders alone (no crossfade) rather than nothing
 * at all.
 */
function buildTextContent(node: TextNode, ctx: NodeFactoryContext, frame: number): TextContentBuild | undefined {
  const renderKey = computeTextNodeRenderKey(node, frame);
  const entry = ctx.textRenderRegistry?.resolve(renderKey);
  if (entry === undefined) {
    return undefined;
  }

  const extrudeDepth = resolveNumberProperty(node.extrudeDepth ?? 0, frame);
  // A staggered or physics-animated node needs every glyph's own opacity/
  // position independently settable each frame (apply-text-effects.ts),
  // which the default shared-by-(page,color) materials do not allow; see
  // buildTextGroup's own doc. Shared between the primary and (when present)
  // "from" morph group builds below: node.morph itself does not need this
  // (resolveGlyphMorphStates resolves the same opacity for every glyph on a
  // given side, so sharing materials within a side stays correct), but a
  // node combining morph with stagger/physics on its primary text still
  // needs it for that text's own group.
  const styleOptions = {
    color: resolveColorProperty(node.color, frame),
    extrudeDepth,
    whiteBalanceGain: ctx.whiteBalanceGain,
    perGlyphMaterial: node.stagger !== undefined || node.physics !== undefined,
    ...(node.fill !== undefined && { fill: resolveTextFill(node.fill, frame) }),
    ...(node.outline !== undefined && { outline: resolveTextOutline(node.outline, frame) }),
    ...(node.glow !== undefined && { glow: resolveTextGlow(node.glow, frame) }),
    ...(node.shadow !== undefined && { shadow: resolveTextShadow(node.shadow, frame) }),
  };

  const resources = buildTextGroup(entry.data, {
    ...styleOptions,
    font: { bytes: entry.fontBytes, contentHash: entry.fontContentHash },
  });

  if (node.morph === undefined) {
    return { renderKey, text: resources, textGlyphs: entry.data.glyphs };
  }

  const fromEntry = ctx.textRenderRegistry?.resolve(
    computeTextNodeRenderKey({ ...node, content: node.morph.from }, frame),
  );
  if (fromEntry === undefined) {
    return { renderKey, text: resources, textGlyphs: entry.data.glyphs };
  }

  const fromResources = buildTextGroup(fromEntry.data, {
    ...styleOptions,
    font: { bytes: fromEntry.fontBytes, contentHash: fromEntry.fontContentHash },
  });

  return {
    renderKey,
    text: resources,
    textGlyphs: entry.data.glyphs,
    textMorph: { from: fromResources, fromGlyphs: fromEntry.data.glyphs },
  };
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
      if (node.geometry !== undefined && owned?.meshGeometry !== undefined) {
        // Mirrors OwnedResources.video's own identical "rebuild only when the
        // key actually changes" gate: a node.geometry edit is rare relative
        // to every other per-frame call, so this avoids allocating (and
        // disposing) a brand new BufferGeometry on every single frame for a
        // shape whose own parameters never change.
        const geometryKey = JSON.stringify(node.geometry);
        if (owned.meshGeometry.geometryKey !== geometryKey) {
          owned.meshGeometry.geometry.dispose();
          owned.meshGeometry = { geometry: buildProceduralGeometry(node.geometry), geometryKey };
        }
        mesh.geometry = owned.meshGeometry.geometry;
      } else {
        mesh.geometry = resolveMeshGeometry(node.geometryRef, ctx.geometryRegistry);
      }
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
      camera.aspect = ctx.aspect ?? 1;
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
      // Rebuilds this node's real content whenever the resolved render key
      // at this frame differs from whatever it was last built from - most
      // often because a keyframed variationAxes resolves a genuinely
      // different instance (different glyph outlines, not just a different
      // advance width; see TextNode.variationAxes' own doc), including the
      // very first time this ever resolves at all (owned.textLastRenderKey
      // starts undefined, which never equals a real key). A miss
      // (buildTextContent returns undefined - the resolved key's own
      // TextRenderEntry is not yet registered) leaves whatever was
      // previously built, if anything, in place rather than tearing it
      // down - the same "asset not ready" tolerance every other
      // registry-resolved node kind already has.
      const renderKey = computeTextNodeRenderKey(node, frame);
      if (owned !== undefined && owned.textLastRenderKey !== renderKey) {
        const built = buildTextContent(node, ctx, frame);
        if (built !== undefined) {
          if (owned.text !== undefined) {
            object3D.remove(owned.text.group);
            disposeTextGroupResources(owned.text);
          }
          if (owned.textMorph !== undefined) {
            object3D.remove(owned.textMorph.from.group);
            disposeTextGroupResources(owned.textMorph.from);
          }
          object3D.add(built.text.group);
          if (built.textMorph !== undefined) {
            object3D.add(built.textMorph.from.group);
          }
          owned.text = built.text;
          owned.textGlyphs = built.textGlyphs;
          owned.textMorph = built.textMorph;
          owned.textLastRenderKey = built.renderKey;
        }
      }

      const color = resolveColorProperty(node.color, frame);
      const fontSize = resolveNumberProperty(node.fontSize, frame);
      // Glyph geometry is built once per resolved render key, in
      // font-size-independent em units (see build-text-group.ts); a
      // fontSize *animating* over time is exactly why this is a per-frame
      // scale multiply here rather than baked into the geometry.
      object3D.scale.multiplyScalar(fontSize);
      owned?.text?.setColor(color[0], color[1], color[2], color[3]);
      owned?.textMorph?.from.setColor(color[0], color[1], color[2], color[3]);
      if (node.fill !== undefined) {
        const fill = resolveTextFill(node.fill, frame);
        owned?.text?.setFill?.(fill);
        owned?.textMorph?.from.setFill?.(fill);
      }
      if (node.outline !== undefined) {
        const outline = resolveTextOutline(node.outline, frame);
        owned?.text?.setOutline?.(outline);
        owned?.textMorph?.from.setOutline?.(outline);
      }
      if (node.glow !== undefined) {
        const glow = resolveTextGlow(node.glow, frame);
        owned?.text?.setGlow?.(glow);
        owned?.textMorph?.from.setGlow?.(glow);
      }
      if (node.shadow !== undefined) {
        const shadow = resolveTextShadow(node.shadow, frame);
        owned?.text?.setShadow?.(shadow);
        owned?.textMorph?.from.setShadow?.(shadow);
      }
      if (
        (node.stagger !== undefined || node.physics !== undefined || node.path !== undefined) &&
        owned?.text !== undefined &&
        owned.textGlyphs !== undefined
      ) {
        const needsLineTexts = node.stagger?.grouping === "grapheme" || node.physics?.grouping === "grapheme";
        const lineTexts = needsLineTexts ? node.content.split("\n") : undefined;
        applyTextEffects(
          owned.text.group,
          owned.textGlyphs,
          { stagger: node.stagger, physics: node.physics, path: node.path },
          frame,
          lineTexts,
        );
      }
      if (
        node.morph !== undefined &&
        owned?.text !== undefined &&
        owned.textGlyphs !== undefined &&
        owned.textMorph !== undefined
      ) {
        const progress = resolveNumberProperty(node.morph.progress, frame);
        const needsLineTexts = node.morph.grouping === "grapheme";
        applyTextMorph(
          owned.text.group,
          owned.textGlyphs,
          owned.textMorph.from.group,
          owned.textMorph.fromGlyphs,
          node.morph.grouping,
          progress,
          needsLineTexts ? node.content.split("\n") : undefined,
          needsLineTexts ? node.morph.from.split("\n") : undefined,
        );
      }
      return;
    }

    case "image": {
      // assetRef is a plain string, not a Property<T>: it cannot change
      // frame to frame on a persisting node id (a new/different assetRef
      // means a new node id in practice), so there is no per-frame
      // "did node.assetRef itself change" check the way text's own
      // render-key comparison has. What CAN change frame to frame is
      // whether ctx.textureRegistry now resolves an assetRef it did not
      // resolve on an earlier call: a caller whose own asset bytes arrive
      // asynchronously, after this node's own first reconcile already ran
      // (a one-shot render pipeline never hits this - its registry is
      // always fully populated before the very first reconcile, so
      // buildImageObject's own resolve above already succeeded there; a
      // live, progressively-loading preview - see apps/studio's own
      // preview-assets/build-preview-registries.ts - is what actually
      // exercises this), needs exactly the same "retry while still
      // unresolved" tolerance buildTextContent's own render-key check
      // already gives text nodes. owned.image stays undefined for as long
      // as this node is still showing the placeholder (see that field's
      // own doc), so its presence alone is what "already resolved, no
      // need to retry" means here - unlike text, there is no separate key
      // to compare, since a resolved image's own content can never change
      // again once found.
      if (owned !== undefined && owned.image === undefined) {
        const texture = ctx.textureRegistry?.resolve(node.assetRef);
        if (texture !== undefined) {
          const mesh = object3D as THREE.Mesh;
          const { geometry, material } = buildResolvedImageMesh(texture);
          owned.material?.dispose();
          mesh.geometry = geometry;
          mesh.material = material;
          owned.material = material;
          owned.image = { geometry };
        }
      }
      return;
    }

    case "video": {
      applyVideoNodeProperties(node, object3D as THREE.Mesh, ctx, frame, owned);
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

    case "model": {
      // See `OwnedResources.model`'s own doc for why a caller whose own
      // registry populates asynchronously (`apps/studio`'s own live
      // viewport) needs this retried on later reconciles, not resolved
      // only once at `buildThreeObject` time - mirrors `"image"`'s own
      // identical retry above, adapted for `model`'s own different
      // placeholder shape: an empty `THREE.Group` (`owned: {}`, no
      // `owned.model` yet) rather than a mesh with a directly swappable
      // geometry/material, so the freshly-built model's own cloned
      // hierarchy is grafted on as a *child* of that persistent group
      // instead of replacing `object3D` outright (which this function has
      // no way to do - it only ever receives the already-reconciled
      // `object3D` reference, never a way to replace it in the scene
      // graph). This graft is transparent to every other system that
      // touches a model node: `applyModelProperties` itself never reads
      // `object3D` at all, only `owned.model` (see its own doc), so nesting
      // one level deeper here changes nothing about how animation/morph
      // state is driven; disposal (`reconciler.ts`'s own `disposeEntry`)
      // only ever reads `owned.model.skeletons` directly, never traverses
      // `object3D`; and `pickNodeAtPoint`'s own name lookup already walks
      // arbitrarily many parent levels to find `node.id` (a raycast can
      // already hit a leaf mesh nested several levels deep inside a
      // model's own hierarchy even without this extra level), so grafting
      // is transparent to picking too.
      if (owned !== undefined && owned.model === undefined) {
        const entry = ctx.modelRegistry?.resolve(node.assetRef);
        if (entry !== undefined) {
          const built = buildModelObject(node, entry);
          object3D.add(built.object3D);
          owned.model = built.owned?.model;
        }
      }
      applyModelProperties(node, owned?.model, frame, ctx);
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
 * Applies this frame's resolved clip weights/time-scales and morph-target
 * weights onto a `model` node's own pre-built `ModelOwnedResources`, driving
 * every clip's own `AnimationAction.time`/`.weight` directly rather than
 * accumulating via repeated `mixer.update(dt)` calls: unlike
 * `@cadra/physics`/`@cadra/particles`, sampling a clip at a given local time
 * is a pure function of that time alone (see `ModelNode`'s own doc), so
 * computing each action's own local time directly from `frame` and calling
 * `mixer.update(0)` once resolves frame N identically whether every prior
 * frame was ever rendered or not - a stronger determinism guarantee than
 * either of those two packages' own "bake incrementally" pattern needs.
 *
 * A `clips` entry naming a clip the loaded asset does not have is a silent
 * no-op for that entry alone (see `ModelNode`'s own doc); any pre-built
 * action *not* referenced by this frame's own `clips` gets `weight = 0`
 * (contributes nothing), rather than being destroyed - the same "mute, not
 * rebuild" treatment every other per-frame property in this file gets.
 *
 * Explicit `morphTargets` are applied *after* `mixer.update(0)`: a clip can
 * itself carry a baked morph-target-influence track, and an author's own
 * explicit `morphTargets` weight for the same target is meant to override
 * it, not race it.
 */
function applyModelProperties(
  node: ModelNode,
  model: ModelOwnedResources | undefined,
  frame: number,
  ctx: NodeFactoryContext,
): void {
  if (model === undefined) {
    return;
  }
  const fps = ctx.fps ?? 30;

  const referencedClipNames = new Set<string>();
  for (const clipConfig of node.clips ?? []) {
    const action = model.actions.get(clipConfig.name);
    if (action === undefined) {
      continue;
    }
    referencedClipNames.add(clipConfig.name);
    const timeScale = clipConfig.timeScale ?? 1;
    const rawTime = (frame / fps) * timeScale;
    action.time = resolveModelClipLocalTime(rawTime, action.getClip().duration, clipConfig.loop ?? "repeat");
    action.weight = resolveNumberProperty(clipConfig.weight, frame);
  }
  for (const [name, action] of model.actions) {
    if (!referencedClipNames.has(name)) {
      action.weight = 0;
    }
  }
  model.mixer.update(0);

  for (const [targetName, weightProperty] of Object.entries(node.morphTargets ?? {})) {
    const weight = resolveNumberProperty(weightProperty, frame);
    for (const mesh of model.morphMeshes) {
      const index = mesh.morphTargetDictionary?.[targetName];
      if (index !== undefined && mesh.morphTargetInfluences !== undefined) {
        mesh.morphTargetInfluences[index] = weight;
      }
    }
  }
}

/**
 * Maps a raw, unbounded clip-local time (`(frame / fps) * timeScale`,
 * which can be negative when `timeScale` is negative, or exceed `duration`
 * for any clip shorter than the node has been "playing") into the clip's
 * own `[0, duration]` range: `"repeat"` wraps modulo `duration` (correcting
 * for JS's `%` returning a negative result for a negative left operand, so
 * a reversed clip - a negative `timeScale` - still wraps into a valid
 * range rather than sampling before the clip's own start), `"clamp"` holds
 * at either end. `duration <= 0` (a degenerate, zero-length clip) always
 * resolves to `0`, since there is no meaningful time to wrap or clamp to.
 */
function resolveModelClipLocalTime(rawTime: number, duration: number, loop: "repeat" | "clamp"): number {
  if (duration <= 0) {
    return 0;
  }
  if (loop === "clamp") {
    return Math.min(Math.max(rawTime, 0), duration);
  }
  const wrapped = rawTime % duration;
  return wrapped < 0 ? wrapped + duration : wrapped;
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

/** Constructs a real `THREE.BufferGeometry` from an inline `MeshGeometryConfig`; see `resolveMeshNodeGeometry`. */
function buildProceduralGeometry(config: MeshGeometryConfig): THREE.BufferGeometry {
  switch (config.type) {
    case "box":
      return new THREE.BoxGeometry(config.width ?? 1, config.height ?? 1, config.depth ?? 1);
    case "sphere":
      return new THREE.SphereGeometry(config.radius ?? 0.5, config.widthSegments ?? 16, config.heightSegments ?? 12);
    case "plane":
      return new THREE.PlaneGeometry(config.width ?? 1, config.height ?? 1);
    case "torus":
      return new THREE.TorusGeometry(
        config.radius ?? 0.4,
        config.tube ?? 0.15,
        config.radialSegments ?? 12,
        config.tubularSegments ?? 24,
      );
    case "cylinder":
      return new THREE.CylinderGeometry(
        config.radiusTop ?? 0.5,
        config.radiusBottom ?? 0.5,
        config.height ?? 1,
        config.radialSegments ?? 16,
      );
    case "cone":
      return new THREE.ConeGeometry(config.radius ?? 0.5, config.height ?? 1, config.radialSegments ?? 16);
    case "capsule":
      return new THREE.CapsuleGeometry(
        config.radius ?? 0.3,
        config.length ?? 0.5,
        config.capSegments ?? 4,
        config.radialSegments ?? 12,
      );
  }
}

/**
 * Decides what `THREE.BufferGeometry` a `mesh` node's own `THREE.Mesh`
 * carries, and what (if anything) the reconciler comes to own as a result -
 * the geometry-side counterpart to `resolveMeshNodeMaterial` immediately
 * below, same shape: `node.geometry` (a `MeshGeometryConfig`), when present,
 * takes over entirely from `geometryRef` and gets a freshly constructed,
 * per-node `THREE.BufferGeometry` that only this node's own entry owns
 * (tracked so `disposeEntry` in `reconciler.ts` disposes it - never a
 * shared/pooled registry instance). Otherwise, falls back to `geometryRef`'s
 * registry-resolved (possibly shared/pooled) geometry, owning nothing, the
 * pre-existing behavior.
 */
function resolveMeshNodeGeometry(
  node: MeshNode,
  ctx: NodeFactoryContext,
): { geometry: THREE.BufferGeometry; owned: OwnedResources | undefined } {
  if (node.geometry === undefined) {
    return { geometry: resolveMeshGeometry(node.geometryRef, ctx.geometryRegistry), owned: undefined };
  }
  const geometry = buildProceduralGeometry(node.geometry);
  return { geometry, owned: { meshGeometry: { geometry, geometryKey: JSON.stringify(node.geometry) } } };
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
 * Applies this frame's resolved state onto a `video` node's own mesh:
 * swaps `mesh.geometry`/`mesh.material` to a real decoded frame only when
 * `computeVideoFrameRenderKey` actually resolves to something *and* that
 * key differs from `owned.video`'s own last-built one (a video held on a
 * single frame - `playbackRate: 0` is not itself valid, but
 * `outOfRangeBehavior: "hold"` past the trim range holds on `outFrame`
 * indefinitely - resolves to the exact same key every subsequent frame,
 * so this never rebuilds anything for it, mirroring
 * `applySatoriLayerProperties`'s own identical "only rebuild on an actual
 * key change" rationale exactly), then applies `opacity`/`blendMode` every
 * frame regardless: `opacity` is a genuine `Property<number>`, independent
 * of whether the decoded pixels changed at all this frame, and
 * `blendMode`, while not itself animatable, must be reapplied every frame
 * a rebuild happened anyway, since that replaces `mesh.material` with a
 * fresh, blend-mode-unset instance.
 *
 * Unlike `applySatoriLayerProperties` (whose own `object3D` is an empty
 * `THREE.Group`, with the real mesh added as a child only once one
 * exists), a `video` node's own `object3D` is already a real `THREE.Mesh`
 * from the moment `buildThreeObject` builds it (on the shared placeholder
 * geometry/a placeholder-colored material, exactly like `image`'s own
 * not-yet-resolved case) - so this only ever *mutates* that existing
 * mesh's own `.geometry`/`.material` in place, never replaces `object3D`
 * itself. The swapped-away previous material is disposed via the shared
 * `owned.material` field (reassigned to the new one here, reusing exactly
 * the same generic disposal path every other placeholder-material node
 * kind's own material already goes through - not tracked redundantly a
 * second time inside `owned.video`); the swapped-away previous *geometry*
 * and *texture* are `owned.video`'s own responsibility. The geometry,
 * because - unlike material - there is no shared `owned.geometry` field
 * this reconciler already disposes generically. The texture, because
 * unlike `TextureRegistry` (which hands the reconciler an
 * already-wrapped, registry-owned `THREE.Texture` it correctly never
 * disposes), `VideoFrameRegistry` only ever hands back raw decoded pixels
 * (`entry.image`, or `entry.pixels`/`.width`/`.height` for a Node-decoded
 * entry with no `ImageBitmap` at all - see `VideoFrameRenderEntry`'s own
 * doc) - the `THREE.Texture` wrapping them is created fresh right here via
 * `createImageTexture`/`createDataTexture` respectively, so it is
 * reconciler-owned and must be disposed like any other owned resource,
 * both on the next swap and (via `owned.video.texture` - see
 * `reconciler.ts`'s own `disposeEntry`) on final teardown.
 *
 * No-ops the geometry/material/texture swap (but still applies `opacity`)
 * when `ctx.videoFrameRegistry` does not resolve anything for this exact
 * frame: the same "not yet ready is an expected runtime state" fallback
 * to the documented placeholder every other registry-resolved node kind
 * already has.
 */
function applyVideoNodeProperties(
  node: VideoNode,
  mesh: THREE.Mesh,
  ctx: NodeFactoryContext,
  frame: number,
  owned: OwnedResources | undefined,
): void {
  const renderKey = computeVideoFrameRenderKey(node, frame);
  const entry = ctx.videoFrameRegistry?.resolve(renderKey);

  if (entry !== undefined && owned !== undefined && owned.video?.lastRenderKey !== renderKey) {
    owned.video?.geometry.dispose();
    owned.video?.texture.dispose();
    owned.material?.dispose();

    const naturalWidth: number | undefined =
      "image" in entry ? (entry.image as { width?: number } | undefined)?.width : entry.width;
    const naturalHeight: number | undefined =
      "image" in entry ? (entry.image as { height?: number } | undefined)?.height : entry.height;
    const aspect =
      naturalWidth !== undefined && naturalHeight !== undefined && naturalHeight > 0
        ? naturalWidth / naturalHeight
        : 1;
    const geometry = new THREE.PlaneGeometry(1, 1 / aspect);
    const texture = "image" in entry ? createImageTexture(entry.image) : createDataTexture(entry.pixels, entry.width, entry.height);
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });

    mesh.geometry = geometry;
    mesh.material = material;
    owned.material = material;
    owned.video = { geometry, texture, lastRenderKey: renderKey };
  }

  const material = mesh.material as THREE.MeshBasicMaterial;
  material.opacity = resolveNumberProperty(node.opacity, frame);
  applyMeshBasicMaterialBlendMode(material, node.blendMode);
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
    applyMeshBasicMaterialBlendMode(resources.material, node.blendMode);
  }
}

/**
 * Sets a material's Three.js blending mode to match a `VideoBlendMode`
 * (also `SatoriNode`'s own `blendMode`, since `SatoriBlendMode` is a
 * literal type alias for `VideoBlendMode` - one shared enum, one shared
 * implementation, for both node kinds that composite generated/uploaded
 * pixel content over whatever renders beneath them).
 * `'normal'`/`'add'`/`'multiply'` map directly to Three.js's own built-in
 * blending constants; `'screen'` has no built-in equivalent, so it is
 * expressed via `CustomBlending` with explicit factors implementing the
 * real screen-blend formula `result = src + dst - src * dst`: with the
 * `AddEquation` (`result = src * srcFactor + dst * dstFactor`),
 * `srcFactor = 1 - dst` (`OneMinusDstColorFactor`) and `dstFactor = 1`
 * (`OneFactor`) gives `src * (1 - dst) + dst * 1 = src + dst - src * dst`,
 * exactly that formula.
 */
function applyMeshBasicMaterialBlendMode(material: THREE.Material, blendMode: VideoBlendMode | undefined): void {
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
