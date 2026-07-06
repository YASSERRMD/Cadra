import {
  type AnimatableTransform,
  type LightNode,
  type LightType,
  resolveBooleanProperty,
  resolveColorProperty,
  resolveNumberProperty,
  resolveVector3Property,
  type SceneNode,
} from "@cadra/core";
import * as THREE from "three";

import type { GeometryRegistry, MaterialRegistry } from "./registries.js";

/**
 * Geometry shared by every `text` and `image` placeholder node, module-level
 * so it is constructed exactly once per process and never disposed: the same
 * ownership rule as a registry-provided geometry (see `registries.ts`), even
 * though this one lives here rather than in a registry, since text/image
 * placeholders are not `mesh` nodes and do not go through `geometryRef`.
 *
 * Real glyph rendering (text) and real texture loading (image) are deferred:
 * text to a future font/glyph system, image to Phase 12's asset pipeline.
 * This plane is purely a visible stand-in shape until then.
 */
const PLACEHOLDER_PLANE_GEOMETRY = new THREE.PlaneGeometry(1, 1);

/** Fallback color for `image` placeholders, since `assetRef` cannot resolve to real image data yet. */
const IMAGE_PLACEHOLDER_COLOR = 0x808080;

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
 * Dependencies the node factory needs to build/update `mesh` nodes. Kept as
 * one bag so `createThreeObject`/`applyNodeProperties` share a single
 * signature regardless of node kind.
 */
export interface NodeFactoryContext {
  geometryRegistry: GeometryRegistry;
  materialRegistry: MaterialRegistry;
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
  /** The per-node placeholder material created for a `text` or `image` node. */
  material: THREE.Material;
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

    case "text": {
      // node.color is Property<ColorRGBA> now, not resolved to a concrete
      // value here: applyNodeProperties (called unconditionally right after
      // this, for every node on every reconcile) sets the real,
      // frame-resolved color, so this constructor-time placeholder is never
      // actually observed. Mirrors the "camera" branch's fov/near/far/target
      // deferral above.
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(PLACEHOLDER_PLANE_GEOMETRY, material);
      return { object3D: mesh, owned: { material } };
    }

    case "image": {
      const material = new THREE.MeshBasicMaterial({ color: IMAGE_PLACEHOLDER_COLOR });
      const mesh = new THREE.Mesh(PLACEHOLDER_PLANE_GEOMETRY, material);
      return { object3D: mesh, owned: { material } };
    }
  }
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
      const mesh = object3D as THREE.Mesh;
      const color = resolveColorProperty(node.color, frame);
      (mesh.material as THREE.MeshBasicMaterial).color.setRGB(...colorToRgbTuple(color));
      return;
    }

    case "image":
      // Fixed placeholder color; assetRef cannot resolve to real image data
      // until Phase 12's asset pipeline exists, so there is nothing to react to.
      return;
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
