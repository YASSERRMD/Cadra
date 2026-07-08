import type { ParticleSystemNode } from "@cadra/core";
import * as THREE from "three";
import { float, Fn, If, instancedArray, instanceIndex, max, texture, uint, uniform } from "three/tsl";
import { type Node, PointsNodeMaterial } from "three/webgpu";

import { applyCollidersTSL } from "./tsl-colliders.js";
import { resolveColorOverLifeTSL, resolveSizeOverLifeTSL } from "./tsl-color-size-curves.js";
import { jitterDirectionTSL } from "./tsl-direction-jitter.js";
import { sampleEmitterShapeTSL } from "./tsl-emitter-shape.js";
import { computeAccelerationTSL } from "./tsl-forces.js";
import { particleHashSignedTSL } from "./tsl-hash.js";
import { normalizeOrZero } from "./vector-math.js";

/**
 * The WebGPU compute path's particle system (Phase 67): GPU-resident
 * storage buffers, written by one compute kernel dispatched once per
 * simulated frame step, read directly by a `PointsNodeMaterial` at draw
 * time with no CPU round trip. See `./cpu-simulation.ts`'s own doc for why
 * the WebGL2 fallback is a wholly separate CPU implementation rather than
 * sharing this one.
 *
 * `PointsNodeMaterial` (not the plainer `SpriteNodeMaterial` it extends)
 * specifically for its own `sizeNode` property - but attached to a
 * `THREE.Sprite`, not `THREE.Points`: `sizeNode` only takes effect on the
 * sprite-quad vertex path (`setupVertexSprite`), since WebGPU's native
 * point-primitive rendering (what a `THREE.Points` object actually uses) is
 * hard-locked to a constant 1px size regardless of `sizeNode`.
 *
 * A plain `THREE.Sprite` with its own `count` set to `maxParticles` is the
 * draw call, not a `THREE.InstancedMesh`: three.js's own `RenderObject`
 * checks a plain `object.count` field generically for any object type, and
 * an `InstancedMesh` would additionally allocate a per-instance 4x4 matrix
 * buffer this system has no use for (`positionNode`/`sizeNode` already
 * supply each instance's transform directly from the storage buffers).
 */

const WORKGROUP_SIZE = 64;

/** A `renderer.compute(...)`-callable GPU compute node, as constructed by `Fn(...)().compute(...)`. */
export type ComputeDispatchable = Node;

export interface GpuParticleSystem {
  readonly object3D: THREE.Object3D;
  /**
   * Advances the simulation to `frame` (or resets and re-simulates from
   * frame 0 on a backward seek), dispatching one compute step per simulated
   * frame via the injected `compute` callback. Mirrors
   * `ParticleCpuSimulation.advanceTo`'s exact semantics; the GPU-resident
   * buffers are the state; nothing is returned since the material already
   * reads them directly.
   */
  advanceTo(frame: number): void;
  dispose(): void;
}

/** Ring-buffer emission bookkeeping, mirroring `./cpu-simulation.ts`'s own `stepOnce` exactly (same formula, same oversubscription cap). */
interface EmissionState {
  spawnCursor: number;
  emissionAccumulator: number;
}

function stepEmission(state: EmissionState, emissionRate: number, dt: number, maxParticles: number): { spawnStart: number; spawnCount: number } {
  state.emissionAccumulator = Math.min(state.emissionAccumulator + emissionRate * dt, maxParticles);
  const spawnCount = Math.min(maxParticles, Math.floor(state.emissionAccumulator));
  state.emissionAccumulator -= spawnCount;
  const spawnStart = state.spawnCursor;
  state.spawnCursor = (state.spawnCursor + spawnCount) % maxParticles;
  return { spawnStart, spawnCount };
}

export function createGpuParticleSystem(
  node: ParticleSystemNode,
  numericSeed: number,
  emitterSeed: number,
  fps: number,
  compute: (computeNode: ComputeDispatchable) => void,
  resolveTexture?: (ref: string) => THREE.Texture | undefined,
): GpuParticleSystem {
  const maxParticles = node.maxParticles;
  const dt = 1 / fps;
  const baseDirection = normalizeOrZero(node.direction);

  const positionBuffer = instancedArray(maxParticles, "vec3").setName("cadraParticlePosition");
  const velocityBuffer = instancedArray(maxParticles, "vec3").setName("cadraParticleVelocity");
  const ageBuffer = instancedArray(maxParticles, "float").setName("cadraParticleAge");
  const lifetimeBuffer = instancedArray(maxParticles, "float").setName("cadraParticleLifetime");
  const startSizeBuffer = instancedArray(maxParticles, "float").setName("cadraParticleStartSize");

  const frameUniform = uniform(0, "uint");
  const spawnStartUniform = uniform(0, "uint");
  const spawnCountUniform = uniform(0, "uint");
  const dtUniform = uniform(dt, "float");
  const numericSeedUniform = uniform(numericSeed >>> 0, "uint");
  const emitterSeedUniform = uniform(emitterSeed >>> 0, "uint");
  const curlSeedUniform = uniform((numericSeed ^ emitterSeed) >>> 0, "uint");
  const maxParticlesUniform = uniform(maxParticles, "uint");

  const stepKernel = Fn(() => {
    const i = instanceIndex;
    const offset = i.sub(spawnStartUniform).add(maxParticlesUniform).mod(maxParticlesUniform);
    const isNewlySpawned = offset.lessThan(spawnCountUniform);

    If(isNewlySpawned, () => {
      const spawnPosition = sampleEmitterShapeTSL(
        node.shape,
        numericSeedUniform,
        emitterSeedUniform,
        uint(i),
        frameUniform,
        0,
      );
      positionBuffer.element(i).assign(spawnPosition);

      const speedVariance = node.initialSpeedVariance ?? 0;
      const speedJitter = particleHashSignedTSL(numericSeedUniform, emitterSeedUniform, uint(i), frameUniform, 20);
      const speed = float(node.initialSpeed).mul(float(1).add(speedJitter.mul(speedVariance))) as Node<"float">;

      const direction = jitterDirectionTSL(
        baseDirection,
        node.spreadAngle ?? 0,
        numericSeedUniform,
        emitterSeedUniform,
        uint(i),
        frameUniform,
        21,
      );
      velocityBuffer.element(i).assign(direction.mul(speed));

      ageBuffer.element(i).assign(float(0));

      const lifetimeVariance = node.lifetimeVarianceSeconds ?? 0;
      const lifetimeJitter = particleHashSignedTSL(numericSeedUniform, emitterSeedUniform, uint(i), frameUniform, 23);
      const lifetimeValue = max(
        dtUniform,
        float(node.lifetimeSeconds).add(lifetimeJitter.mul(lifetimeVariance)),
      ) as Node<"float">;
      lifetimeBuffer.element(i).assign(lifetimeValue);

      const sizeVariance = node.sizeVariance ?? 0;
      const sizeJitter = particleHashSignedTSL(numericSeedUniform, emitterSeedUniform, uint(i), frameUniform, 24);
      const sizeValue = float(node.startSize).mul(
        max(float(0), float(1).add(sizeJitter.mul(sizeVariance))),
      ) as Node<"float">;
      startSizeBuffer.element(i).assign(sizeValue);
    }).Else(() => {
      const age = ageBuffer.element(i).toVar();
      const lifetime = lifetimeBuffer.element(i);

      If(age.lessThan(lifetime), () => {
        const position = positionBuffer.element(i).toVar();
        const velocity = velocityBuffer.element(i).toVar();

        const acceleration = computeAccelerationTSL(node.forces, position, velocity, curlSeedUniform, age);
        const steppedVelocity = velocity.add(acceleration.mul(dtUniform));
        const steppedPosition = position.add(steppedVelocity.mul(dtUniform));

        const resolved = applyCollidersTSL(node.colliders, steppedPosition, steppedVelocity);

        positionBuffer.element(i).assign(resolved.position);
        velocityBuffer.element(i).assign(resolved.velocity);
        ageBuffer.element(i).assign(age.add(dtUniform));
      });
    });
  })().compute(maxParticles, [WORKGROUP_SIZE]);

  const material = new PointsNodeMaterial({ transparent: true, depthWrite: false });
  material.positionNode = positionBuffer.toAttribute();

  const ageAttribute = ageBuffer.toAttribute();
  const lifetimeAttribute = lifetimeBuffer.toAttribute();
  const startSizeAttribute = startSizeBuffer.toAttribute();
  const safeLifetime = max(lifetimeAttribute, float(1e-6)) as Node<"float">;
  const lifeFraction = ageAttribute.div(safeLifetime) as Node<"float">;
  const isAlive = ageAttribute.lessThan(lifetimeAttribute).and(lifetimeAttribute.greaterThan(0));

  material.sizeNode = isAlive.select(
    startSizeAttribute.mul(resolveSizeOverLifeTSL(node.sizeOverLife, lifeFraction)),
    float(0),
  ) as Node<"float">;

  let colorNode = resolveColorOverLifeTSL(node.colorOverLife, lifeFraction);
  const resolvedTexture = node.textureRef !== undefined ? resolveTexture?.(node.textureRef) : undefined;
  if (resolvedTexture !== undefined) {
    colorNode = colorNode.mul(texture(resolvedTexture)) as Node<"vec4">;
  }
  material.colorNode = colorNode;

  if (node.blendMode === "additive") {
    material.blending = THREE.AdditiveBlending;
  }

  const sprite = new THREE.Sprite(material);
  sprite.count = maxParticles;
  sprite.frustumCulled = false;

  const emission: EmissionState = { spawnCursor: 0, emissionAccumulator: 0 };
  let currentFrame = 0;

  return {
    object3D: sprite,

    advanceTo(frame: number): void {
      if (frame === currentFrame) {
        return;
      }
      if (frame < currentFrame) {
        emission.spawnCursor = 0;
        emission.emissionAccumulator = 0;
        currentFrame = 0;
      }

      while (currentFrame < frame) {
        currentFrame += 1;
        const { spawnStart, spawnCount } = stepEmission(emission, node.emissionRate, dt, maxParticles);
        frameUniform.value = currentFrame;
        spawnStartUniform.value = spawnStart;
        spawnCountUniform.value = spawnCount;
        compute(stepKernel);
      }
    },

    dispose(): void {
      material.dispose();
      // Both the storage-buffer node's own `dispose()` (inherited from the
      // base `Node` class) and its underlying `StorageInstancedBufferAttribute`
      // (`.value`, the actual GPU-resource-holding object) dispatch a
      // `dispose` event a renderer's own resource tracking can listen for;
      // disposing both is harmless (an unheard `dispose` event is a no-op)
      // and avoids under-freeing GPU memory if only one is actually wired up.
      for (const buffer of [positionBuffer, velocityBuffer, ageBuffer, lifetimeBuffer, startSizeBuffer]) {
        buffer.dispose();
        buffer.value?.dispose?.();
      }
    },
  };
}
