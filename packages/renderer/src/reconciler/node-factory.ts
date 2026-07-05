import type { LightNode, LightType, SceneNode, Transform } from "@cadra/core";
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
 * Does not apply transform/visibility; call `applyNodeProperties` right after.
 */
export function createThreeObject(node: SceneNode, ctx: NodeFactoryContext): BuiltObject {
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
      const camera = new THREE.PerspectiveCamera(node.fov, 1, node.near, node.far);
      return { object3D: camera, owned: undefined };
    }

    case "light":
      return { object3D: createLight(node.lightType), owned: undefined };

    case "text": {
      const material = new THREE.MeshBasicMaterial({ color: colorToThree(node.color) });
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
 */
export function applyNodeProperties(
  node: SceneNode,
  object3D: THREE.Object3D,
  ctx: NodeFactoryContext,
): void {
  applyTransform(node.transform, object3D);
  object3D.visible = node.visible;

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
      camera.fov = node.fov;
      camera.near = node.near;
      camera.far = node.far;
      camera.aspect = 1; // Nothing in this phase's scope sets aspect from anywhere else.
      camera.updateProjectionMatrix();
      camera.lookAt(node.target[0], node.target[1], node.target[2]);
      return;
    }

    case "light": {
      applyLightProperties(node, object3D as THREE.Light);
      return;
    }

    case "text": {
      const mesh = object3D as THREE.Mesh;
      (mesh.material as THREE.MeshBasicMaterial).color.setRGB(...colorToRgbTuple(node.color));
      return;
    }

    case "image":
      // Fixed placeholder color; assetRef cannot resolve to real image data
      // until Phase 12's asset pipeline exists, so there is nothing to react to.
      return;
  }
}

/** Applies an `@cadra/core` `Transform` (Euler-XYZ-radians) onto a Three.js object in place. */
function applyTransform(transform: Transform, object3D: THREE.Object3D): void {
  object3D.position.set(transform.position[0], transform.position[1], transform.position[2]);
  // Three.js's default Euler order is XYZ, matching the scene graph's fixed convention.
  object3D.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2]);
  object3D.scale.set(transform.scale[0], transform.scale[1], transform.scale[2]);
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

function applyLightProperties(node: LightNode, light: THREE.Light): void {
  light.color.setRGB(...colorToRgbTuple(node.color));
  light.intensity = node.intensity;
}

/** Converts an `@cadra/core` `ColorRGBA` tuple's RGB channels to a plain 3-tuple for `Color.setRGB`. */
function colorToRgbTuple(
  color: readonly [number, number, number, number],
): [number, number, number] {
  return [color[0], color[1], color[2]];
}

/** Converts an `@cadra/core` `ColorRGBA` to a `THREE.Color` for use in a constructor. */
function colorToThree(color: readonly [number, number, number, number]): THREE.Color {
  return new THREE.Color(color[0], color[1], color[2]);
}
