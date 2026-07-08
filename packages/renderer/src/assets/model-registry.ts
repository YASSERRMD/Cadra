import type * as THREE from "three";

/**
 * A parsed GLTF/GLB model, ready for this renderer to build reconciled
 * instances from (see `node-factory.ts`'s own `"model"` case). `scene` is
 * the model's own root `Object3D` (a `THREE.Group` for a static model, or a
 * hierarchy containing one or more `THREE.SkinnedMesh`es for a rigged one) -
 * never mutated or attached directly: every reconciled `ModelNode` instance
 * clones it (`SkeletonUtils.clone`, which correctly re-binds skinned-mesh
 * skeletons, unlike a plain `Object3D.clone()`), so many nodes may
 * reference the same registry entry independently. `animations` are this
 * asset's own `THREE.AnimationClip`s, by their own authored name -
 * `ModelClipConfig.name` is matched against these exactly.
 */
export interface LoadedModel {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

/**
 * Resolves a `ModelNode.assetRef` to its already-loaded `LoadedModel`.
 * Resolve-only, mirroring `GeometryRegistry`/`MaterialRegistry`'s own
 * contract (`packages/renderer/src/reconciler/registries.ts`): something
 * else loads and registers a model ahead of a `reconcile` call (parsing a
 * GLTF/GLB is async; a reconciler's own `createThreeObject`/
 * `applyNodeProperties` are not). Keyed on the raw `assetRef` alone, not a
 * per-frame-resolved cache key the way `TextRenderRegistry`/
 * `SatoriLayerRenderRegistry` are: a model's own loaded scene/clips never
 * vary by frame (only the *pose* this renderer drives them to does, via
 * `ModelClipConfig`/`morphTargets`, applied fresh every frame in
 * `applyNodeProperties`), so one entry per `assetRef` is always enough,
 * matching `GeometryRegistry`/`MaterialRegistry`'s own simpler `resolve(ref)`
 * shape more than text/satori's per-frame one.
 */
export interface ModelRegistry {
  resolve(assetRef: string): LoadedModel | undefined;
}

/** A `ModelRegistry` a caller can also populate. */
export interface MutableModelRegistry extends ModelRegistry {
  register(assetRef: string, entry: LoadedModel): void;
}

/** A simple in-memory `MutableModelRegistry`, backed by a `Map`. */
export function createInMemoryModelRegistry(): MutableModelRegistry {
  const entries = new Map<string, LoadedModel>();

  return {
    resolve(assetRef: string): LoadedModel | undefined {
      return entries.get(assetRef);
    },
    register(assetRef: string, entry: LoadedModel): void {
      entries.set(assetRef, entry);
    },
  };
}

/**
 * The real default `ModelRegistry` a production `ThreeRenderer` constructs
 * itself with (mirroring `createDefaultEnvironmentRegistry`'s own
 * constructor-injected-with-a-real-default treatment): starts empty, since
 * unlike environment maps or built-in geometry/material refs, there is no
 * sensible built-in default 3D model to pre-seed it with. Returns the wider
 * `MutableModelRegistry` (unlike `createDefaultEnvironmentRegistry`, which
 * never needs mutating again after its own fixed built-in set is seeded):
 * `ThreeRenderer` itself only ever calls `.resolve()` on the narrower
 * `ModelRegistry` interface, but a caller keeping their own reference to the
 * exact same instance can call `.register(assetRef, ...)` on it (e.g. once a
 * real GLTF/GLB finishes loading via `loadGltf`) at any point before or
 * after constructing the renderer with it.
 */
export function createDefaultModelRegistry(): MutableModelRegistry {
  return createInMemoryModelRegistry();
}
