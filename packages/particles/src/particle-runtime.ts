import type { ParticleSystemNode, SceneNode } from "@cadra/core";
import { toNumericSeed } from "@cadra/core";
import * as THREE from "three";

import { createCpuParticleObject } from "./cpu-particle-object.js";
import { createParticleCpuSimulation } from "./cpu-simulation.js";
import { type ComputeDispatchable, createGpuParticleSystem } from "./gpu-particle-system.js";

/**
 * Orchestrates every `ParticleSystemNode` in a composition (Phase 67): one
 * GPU or CPU particle system per node id, created lazily, cached, advanced
 * to the current frame, and disposed once its node disappears from the
 * scene tree - the same "resolve the whole tree once per `renderFrame`,
 * cache per subject, dispose when no longer present" shape
 * `@cadra/physics`'s `createPhysicsBake` already established for rigid
 * bodies, applied here per-node rather than per-composition since each
 * particle system's own state is independent of every other's.
 */

export type ComputeFn = (computeNode: ComputeDispatchable) => void;

export type ParticleRuntimeDependencies =
  | { backend: "webgpu"; compute: ComputeFn; resolveTexture?: (ref: string) => THREE.Texture | undefined }
  | { backend: "webgl2"; resolveTexture?: (ref: string) => THREE.Texture | undefined };

export interface ParticleRuntime {
  /**
   * Ensures a system exists for every `ParticleSystemNode` found under
   * `roots` (creating fresh ones for newly-appeared node ids, disposing
   * ones no longer present), advances each to `frame`, and returns each
   * one's renderable `THREE.Object3D`, keyed by node id.
   */
  resolve(roots: readonly SceneNode[], seed: string | number, frame: number, fps: number): ReadonlyMap<string, THREE.Object3D>;
  dispose(): void;
}

type SystemEntry =
  | { kind: "gpu"; object3D: THREE.Object3D; advanceTo(frame: number): void; dispose(): void }
  | {
      kind: "cpu";
      object3D: THREE.Object3D;
      advanceTo(frame: number): void;
      dispose(): void;
    };

function collectParticleSystemNodes(nodes: readonly SceneNode[], out: ParticleSystemNode[]): void {
  for (const node of nodes) {
    if (node.kind === "particles") {
      out.push(node);
    }
    collectParticleSystemNodes(node.children, out);
  }
}

function createSystemEntry(
  node: ParticleSystemNode,
  numericSeed: number,
  fps: number,
  deps: ParticleRuntimeDependencies,
): SystemEntry {
  const emitterSeed = toNumericSeed(`${node.id}:${node.seed ?? 0}`);

  if (deps.backend === "webgpu") {
    const system = createGpuParticleSystem(node, numericSeed, emitterSeed, fps, deps.compute, deps.resolveTexture);
    return {
      kind: "gpu",
      object3D: system.object3D,
      advanceTo: (frame) => system.advanceTo(frame),
      dispose: () => system.dispose(),
    };
  }

  const simulation = createParticleCpuSimulation(node, numericSeed, emitterSeed, fps);
  const cpuObject = createCpuParticleObject(node, deps.resolveTexture);
  return {
    kind: "cpu",
    object3D: cpuObject.object3D,
    advanceTo: (frame) => cpuObject.update(simulation.advanceTo(frame)),
    dispose: () => cpuObject.dispose(),
  };
}

export function createParticleRuntime(deps: ParticleRuntimeDependencies): ParticleRuntime {
  const systems = new Map<string, SystemEntry>();

  return {
    resolve(roots, seed, frame, fps) {
      const numericSeed = toNumericSeed(seed);
      const particleNodes: ParticleSystemNode[] = [];
      collectParticleSystemNodes(roots, particleNodes);

      const seenIds = new Set<string>();
      const result = new Map<string, THREE.Object3D>();

      for (const node of particleNodes) {
        seenIds.add(node.id);
        let entry = systems.get(node.id);
        if (entry === undefined) {
          entry = createSystemEntry(node, numericSeed, fps, deps);
          systems.set(node.id, entry);
        }
        entry.advanceTo(frame);
        result.set(node.id, entry.object3D);
      }

      for (const [id, entry] of systems) {
        if (!seenIds.has(id)) {
          entry.dispose();
          systems.delete(id);
        }
      }

      return result;
    },

    dispose(): void {
      for (const entry of systems.values()) {
        entry.dispose();
      }
      systems.clear();
    },
  };
}
