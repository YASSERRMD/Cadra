import type { SceneNode, SceneNodeKind, WhiteBalanceGain } from "@cadra/core";
import type { PhysicsTransform } from "@cadra/physics";
import type * as THREE from "three";

import type { ModelRegistry } from "../assets/model-registry.js";
import type { RendererBackend } from "../renderer.js";
import type { SatoriLayerRenderRegistry } from "../svg-layer/satori-layer-render-registry.js";
import { disposeTextGroupResources } from "../text/build-text-group.js";
import type { TextRenderRegistry } from "../text/text-render-registry.js";
import type { VideoFrameRegistry } from "../video-layer/video-frame-registry.js";
import {
  applyNodeProperties,
  createThreeObject,
  type NodeFactoryContext,
  type OwnedResources,
} from "./node-factory.js";
import {
  createDefaultGeometryRegistry,
  createDefaultMaterialRegistry,
  type GeometryRegistry,
  type MaterialRegistry,
  type TextureRegistry,
} from "./registries.js";

/** What the reconciler remembers about one previously-built `SceneNode`. */
interface ReconciledEntry {
  object3D: THREE.Object3D;
  kind: SceneNodeKind;
  owned: OwnedResources | undefined;
}

/**
 * Dependencies a `Reconciler` resolves node references against.
 * `geometryRegistry`/`materialRegistry` are optional; omitted, they default
 * to the small in-memory seed set in `registries.ts`. `textRenderRegistry`/
 * `satoriLayerRenderRegistry` are also optional; omitted, every `text`/
 * `satori` node renders as an empty group (see `node-factory.ts`'s
 * `buildTextObject`/`buildThreeObject`'s own `"satori"` case).
 * `modelRegistry` is optional the same way; omitted, every `"model"` node
 * renders as an empty group too. `textureRegistry` is optional the same
 * way again; omitted, every `"image"` node (and every mesh's own
 * `normalMapRef`/`aoMapRef`) renders as its own documented fallback (see
 * `TextureRegistry`'s own doc). `videoFrameRegistry` is optional the same
 * way once more; omitted, every `"video"` node renders as its own
 * documented placeholder plane (see `VideoFrameRegistry`'s own doc).
 */
export interface ReconcilerOptions {
  geometryRegistry?: GeometryRegistry;
  materialRegistry?: MaterialRegistry;
  textRenderRegistry?: TextRenderRegistry;
  satoriLayerRenderRegistry?: SatoriLayerRenderRegistry;
  modelRegistry?: ModelRegistry;
  textureRegistry?: TextureRegistry;
  videoFrameRegistry?: VideoFrameRegistry;
}

/**
 * Diffs a `SceneNode` tree from `@cadra/core` against whatever it built last
 * time, and applies the minimal set of mutations to a live `THREE.Object3D`
 * tree: create new objects, update existing ones in place (preserving
 * identity), reorder/reparent moved ones, and dispose removed ones.
 *
 * Stateful across calls: `reconcile` always diffs against its own previous
 * output, not against whatever the caller separately remembers.
 */
export interface Reconciler {
  /**
   * Reconciles `nextRoot` against the tree this reconciler built on its last
   * call (or nothing, on the first call). Returns the root `Object3D`, or
   * `null` if `nextRoot` is `null` (which also tears down and disposes the
   * entire current tree).
   *
   * `frame` is the frame every animatable `Property<T>` this reconciler
   * knows how to resolve (currently only a `camera` node's `fov`/`near`/
   * `far`/`target`) is evaluated at; every other node kind's own fields are
   * still plain values, so `frame` has no effect on them.
   *
   * `whiteBalanceGain` is this call's own composition-level white-balance
   * correction (see `NodeFactoryContext.whiteBalanceGain`'s own doc);
   * defaults to a no-op `(1, 1, 1)` gain when omitted. Not itself
   * `Property<T>`/frame-dependent (a composition's own `colorGrading` is
   * fixed for its whole length - see `Composition.colorGrading`'s own
   * doc), but still supplied fresh each call rather than once at
   * `createReconciler` time, since which composition (and so which grade)
   * a given `renderFrame` call is even rendering can differ call to call.
   *
   * `physicsTransforms` is this call's own baked physics result (see
   * `NodeFactoryContext.physicsTransforms`'s own doc), supplied fresh each
   * call for the same reason `whiteBalanceGain` is. Defaults to no override
   * at all when omitted, matching every mesh's pre-Phase-66 behavior.
   *
   * `particleObjects` is this call's own resolved particle systems (see
   * `NodeFactoryContext.particleObjects`'s own doc), supplied fresh each
   * call for the same reason. Defaults to every `"particles"` node
   * rendering as an empty group when omitted.
   *
   * `backend`/`fps` are this renderer's own resolved backend and this
   * composition's own frames-per-second (see `NodeFactoryContext.backend`/
   * `.fps`'s own docs), supplied fresh each call for the same reason.
   * Defaults to every `"volume"` node rendering as an empty group when
   * `backend` is omitted.
   *
   * `aspect` is this composition's own `width / height` (see
   * `NodeFactoryContext.aspect`'s own doc), supplied fresh each call for the
   * same reason. Defaults to `1` (square) when omitted.
   *
   * `seed` is this render's own base seed (see `NodeFactoryContext.seed`'s
   * own doc), supplied fresh each call for the same reason. Defaults to a
   * `"volume"` node's noise field depending only on its own `id`/`seed`,
   * with no composition-level contribution, when omitted.
   */
  reconcile(
    nextRoot: SceneNode | null,
    frame: number,
    whiteBalanceGain?: WhiteBalanceGain,
    physicsTransforms?: ReadonlyMap<string, PhysicsTransform>,
    particleObjects?: ReadonlyMap<string, THREE.Object3D>,
    backend?: RendererBackend,
    fps?: number,
    aspect?: number,
    seed?: string | number,
  ): THREE.Object3D | null;
}

/**
 * Creates a `Reconciler`. With no `options`, `mesh` nodes resolve geometry
 * and material against the small in-memory default registries seeded in
 * `registries.ts`; pass real registries (Phase 12's asset pipeline, once it
 * exists) to override either or both.
 */
export function createReconciler(options: ReconcilerOptions = {}): Reconciler {
  const ctx: NodeFactoryContext = {
    geometryRegistry: options.geometryRegistry ?? createDefaultGeometryRegistry(),
    materialRegistry: options.materialRegistry ?? createDefaultMaterialRegistry(),
    whiteBalanceGain: [1, 1, 1],
    ...(options.textRenderRegistry !== undefined && { textRenderRegistry: options.textRenderRegistry }),
    ...(options.satoriLayerRenderRegistry !== undefined && {
      satoriLayerRenderRegistry: options.satoriLayerRenderRegistry,
    }),
    ...(options.modelRegistry !== undefined && { modelRegistry: options.modelRegistry }),
    ...(options.textureRegistry !== undefined && { textureRegistry: options.textureRegistry }),
    ...(options.videoFrameRegistry !== undefined && { videoFrameRegistry: options.videoFrameRegistry }),
  };

  const entries = new Map<string, ReconciledEntry>();

  /**
   * Runs in three passes, in this order, because pruning must see the
   * pre-reorder Three.js tree: `updateOrCreate` never removes a child from
   * its old parent's `children` array (only `pruneRemoved`'s `removeFromParent`
   * does that, via `THREE.Object3D.remove`'s `children.indexOf` lookup), so
   * a removed node is still findable there when pruning runs. Reordering
   * only after pruning means it only ever reorders children that actually
   * survived into the next tree.
   *
   * 1. updateOrCreate: create/update/reparent every node in `nextRoot`,
   *    collecting which ids are still present.
   * 2. pruneRemoved: detach and dispose every previously-known id absent
   *    from that set.
   * 3. reorderAll: fix up each surviving parent's children order to match
   *    `nextRoot`.
   */
  function reconcile(
    nextRoot: SceneNode | null,
    frame: number,
    whiteBalanceGain?: WhiteBalanceGain,
    physicsTransforms?: ReadonlyMap<string, PhysicsTransform>,
    particleObjects?: ReadonlyMap<string, THREE.Object3D>,
    backend?: RendererBackend,
    fps?: number,
    aspect?: number,
    seed?: string | number,
  ): THREE.Object3D | null {
    ctx.whiteBalanceGain = whiteBalanceGain ?? [1, 1, 1];
    ctx.physicsTransforms = physicsTransforms;
    ctx.particleObjects = particleObjects;
    ctx.backend = backend;
    ctx.fps = fps;
    ctx.aspect = aspect;
    ctx.seed = seed;

    if (nextRoot === null) {
      teardownAll();
      return null;
    }

    const visited = new Set<string>();
    const rootObject = updateOrCreate(nextRoot, null, visited, frame);
    pruneRemoved(visited);
    reorderAll(nextRoot);
    return rootObject;
  }

  /**
   * Creates a brand new node, reuses an existing same-kind node in place, or
   * fully replaces a kind-changed node, then recurses into `node`'s children.
   * Attaches/reparents `object3D` under `parentObject3D` (skipped for the
   * tree root, which has no Three.js parent for this reconciler to manage).
   * Deliberately does not touch `object3D.children`'s order; see `reconcile`.
   */
  function updateOrCreate(
    node: SceneNode,
    parentObject3D: THREE.Object3D | null,
    visited: Set<string>,
    frame: number,
  ): THREE.Object3D {
    visited.add(node.id);
    const existing = entries.get(node.id);

    let object3D: THREE.Object3D;
    if (existing === undefined) {
      object3D = createEntry(node);
    } else if (existing.kind === node.kind) {
      object3D = existing.object3D;
    } else {
      // Kind changed on the same id: full replace. Dispose whatever the old
      // kind owned, drop the old object from its parent, build fresh.
      disposeEntry(existing);
      object3D = createEntry(node);
    }

    // Always re-read from `entries` (rather than trusting `existing`) since
    // both the "brand new" and "kind changed" branches above just replaced
    // this id's entry via createEntry.
    applyNodeProperties(node, object3D, ctx, frame, entries.get(node.id)?.owned);

    if (parentObject3D !== null && object3D.parent !== parentObject3D) {
      // Either brand new, or an existing node that moved to a different
      // parent (reparenting): either way, `add` both attaches it and detaches
      // it from any prior parent first, so this one call covers both cases.
      parentObject3D.add(object3D);
    }

    for (const child of node.children) {
      updateOrCreate(child, object3D, visited, frame);
    }

    return object3D;
  }

  /** Builds a brand new `Object3D` for `node` via the node factory and records it in `entries`. */
  function createEntry(node: SceneNode): THREE.Object3D {
    const built = createThreeObject(node, ctx);
    entries.set(node.id, { object3D: built.object3D, kind: node.kind, owned: built.owned });
    return built.object3D;
  }

  /**
   * Removes and disposes every `entries` id not present in `visited`. Must
   * run before any children-array reordering: a removed node is still
   * sitting in its old parent's live `children` array at this point (nothing
   * upstream of this ever spliced it out), which is exactly what
   * `removeFromParent` needs to find and detach it correctly.
   */
  function pruneRemoved(visited: Set<string>): void {
    for (const [id, entry] of entries) {
      if (!visited.has(id)) {
        disposeEntry(entry);
        entries.delete(id);
      }
    }
  }

  /**
   * Walks `root` and reorders each node's Three.js `children` to match its
   * `SceneNode.children` order. Runs last, after removed nodes are already
   * pruned, so every id it looks up is guaranteed to still be in `entries`.
   */
  function reorderAll(node: SceneNode): void {
    const object3D = entries.get(node.id)?.object3D;
    if (object3D === undefined) {
      return;
    }
    const orderedChildren = node.children.map((child) => {
      // Safe: every child id was just created-or-reused in updateOrCreate
      // above and survived pruneRemoved, so it is always present here.
      const childObject3D = entries.get(child.id)?.object3D;
      return childObject3D as THREE.Object3D;
    });
    reorderChildren(object3D, orderedChildren);
    for (const child of node.children) {
      reorderAll(child);
    }
  }

  /**
   * Reassigns `parent.children` to `orderedChildren` (prefixed by any
   * "foreign" children in their existing relative order) directly rather
   * than through repeated `remove`/`add` calls: every element is already a
   * member of `parent.children` with `.parent` already correctly set, so
   * this is a pure order fix with no add/remove side effects, and a no-op
   * when the order already matches.
   *
   * "Foreign" means not present in `orderedChildren` at all: a node
   * factory can build internal Object3D structure of its own beneath a
   * node's own top-level object (e.g. `text`'s per-line/per-word/per-glyph
   * groups, see `node-factory.ts`'s `buildTextObject`) that has no
   * corresponding `SceneNode` child and so would never appear in
   * `orderedChildren`; without preserving it here, this function would
   * silently discard it the moment it ever disagreed with
   * `parent.children`'s current length, since a plain length/content
   * comparison against only the scene-graph-tracked children cannot tell
   * "genuinely reordered" apart from "something else is also parented here".
   */
  function reorderChildren(parent: THREE.Object3D, orderedChildren: THREE.Object3D[]): void {
    const currentOrder = parent.children;
    const orderedSet = new Set(orderedChildren);
    const foreignChildren = currentOrder.filter((child) => !orderedSet.has(child));
    const desiredOrder = [...foreignChildren, ...orderedChildren];

    if (currentOrder.length === desiredOrder.length) {
      let matches = true;
      for (let i = 0; i < desiredOrder.length; i += 1) {
        if (currentOrder[i] !== desiredOrder[i]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return;
      }
    }
    parent.children = desiredOrder;
  }

  /** Detaches `entry.object3D` from its parent and disposes exactly the resources it owns. */
  function disposeEntry(entry: ReconciledEntry): void {
    entry.object3D.removeFromParent();
    entry.owned?.material?.dispose();
    if (entry.owned?.text !== undefined) {
      disposeTextGroupResources(entry.owned.text);
    }
    if (entry.owned?.textMorph !== undefined) {
      // The "from" half of a morphing text node: its own fully separate
      // TextGroupResources (see OwnedResources.textMorph's own doc), so
      // disposed the same way as entry.owned.text above, independently.
      disposeTextGroupResources(entry.owned.textMorph.from);
    }
    if (entry.owned?.satori !== undefined) {
      entry.owned.satori.geometry.dispose();
      entry.owned.satori.material?.dispose();
      entry.owned.satori.texture?.dispose();
    }
    if (entry.owned?.volume !== undefined) {
      entry.owned.volume.geometry.dispose();
      entry.owned.volume.material.dispose();
    }
    if (entry.owned?.image !== undefined) {
      // Only the geometry: a resolved image's own THREE.Texture came from
      // textureRegistry and is never disposed here, same non-disposal
      // contract as TextureRegistry's own doc establishes for
      // normalMapRef/aoMapRef (the registry - or whatever populated it -
      // owns that lifetime, not the reconciler). The material is already
      // covered by entry.owned.material above (image's per-node material,
      // real-texture or placeholder alike, has always lived there).
      entry.owned.image.geometry.dispose();
    }
    if (entry.owned?.video !== undefined) {
      // Unlike image's own case immediately above, a video node's texture
      // is not registry-owned: videoFrameRegistry only ever hands back raw
      // decoded pixels (an ImageBitmap), and applyVideoNodeProperties
      // wraps them in a fresh THREE.Texture itself - so, unlike image's
      // texture, this one genuinely is this reconciler's own resource and
      // must be disposed here (see OwnedResources.video's own doc). The
      // current material is already covered by entry.owned.material above
      // (applyVideoNodeProperties reassigns that shared field on every
      // swap, exactly like image's own placeholder-to-resolved swap does).
      entry.owned.video.geometry.dispose();
      entry.owned.video.texture.dispose();
    }
    if (entry.owned?.model !== undefined) {
      // Geometries/materials/textures are never disposed here: they are
      // shared with the ModelRegistry's own cached template (and every
      // other reconciled instance of the same assetRef) via
      // SkeletonUtils.clone's "clone the hierarchy, reuse the leaf
      // resources" behavior - see buildModelObject's own doc. Only this
      // instance's own cloned Skeletons (each with their own lazily
      // allocated boneTexture, real GPU memory) are genuinely unique to it.
      for (const skeleton of entry.owned.model.skeletons) {
        skeleton.dispose();
      }
    }
  }

  /** Tears down the entire current tree: every entry is disposed and `entries` is cleared. */
  function teardownAll(): void {
    for (const entry of entries.values()) {
      disposeEntry(entry);
    }
    entries.clear();
  }

  return { reconcile };
}
