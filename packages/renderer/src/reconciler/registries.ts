import * as THREE from "three";

/**
 * Resolves a `MeshNode.geometryRef` to a shared `THREE.BufferGeometry`
 * instance. Implementations pool geometry across every node that references
 * the same id, so the reconciler must never dispose anything a registry
 * returns: only the registry (or whatever populated it) owns that lifetime.
 *
 * Phase 12's asset pipeline is the intended long-term implementation of this
 * interface (loading authored/imported geometry); `createDefaultGeometryRegistry`
 * below is a minimal stand-in so this phase's reconciler is testable without it.
 */
export interface GeometryRegistry {
  resolve(ref: string): THREE.BufferGeometry | undefined;
}

/**
 * Resolves a `MeshNode.materialRef` to a shared `THREE.Material` instance.
 * Same pooling and non-disposal contract as `GeometryRegistry`.
 */
export interface MaterialRegistry {
  resolve(ref: string): THREE.Material | undefined;
}

/** Ids the default geometry registry seeds itself with. */
export const DEFAULT_GEOMETRY_REFS = ["box", "sphere"] as const;

/** Ids the default material registry seeds itself with. */
export const DEFAULT_MATERIAL_REFS = ["default", "wireframe"] as const;

/**
 * A simple in-memory `GeometryRegistry` seeded with a box and a sphere, so
 * tests (and early authoring) can exercise real mesh reconciliation without
 * waiting on Phase 12's real asset pipeline. Every call to `resolve` with a
 * seeded ref returns the exact same shared instance.
 */
export function createDefaultGeometryRegistry(): GeometryRegistry {
  const geometries = new Map<string, THREE.BufferGeometry>([
    ["box", new THREE.BoxGeometry(1, 1, 1)],
    ["sphere", new THREE.SphereGeometry(0.5, 16, 12)],
  ]);

  return {
    resolve(ref: string): THREE.BufferGeometry | undefined {
      return geometries.get(ref);
    },
  };
}

/**
 * A simple in-memory `MaterialRegistry` seeded with a couple of basic
 * materials, mirroring `createDefaultGeometryRegistry`'s purpose.
 */
export function createDefaultMaterialRegistry(): MaterialRegistry {
  const materials = new Map<string, THREE.Material>([
    ["default", new THREE.MeshStandardMaterial({ color: 0xcccccc })],
    ["wireframe", new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true })],
  ]);

  return {
    resolve(ref: string): THREE.Material | undefined {
      return materials.get(ref);
    },
  };
}
