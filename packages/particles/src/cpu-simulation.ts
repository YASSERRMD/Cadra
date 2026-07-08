import type { ParticleSystemNode, Vector3 } from "@cadra/core";

import { applyColliders } from "./colliders.js";
import { resolveColorOverLife, resolveSizeOverLife } from "./color-size-curves.js";
import { jitterDirection } from "./direction-jitter.js";
import { sampleEmitterShape } from "./emitter-shape.js";
import { computeAcceleration } from "./forces.js";
import { particleHashSigned } from "./hash.js";
import { normalizeOrZero } from "./vector-math.js";

/**
 * The WebGL2 fallback's CPU particle simulation (Phase 67): the same
 * emitter/force/collider/lifetime rules the WebGPU compute path simulates on
 * the GPU, stepped instead as a plain per-particle JS loop over typed
 * arrays. A separate implementation, not a shared one the GPU path also
 * calls, because the two run in fundamentally different execution models (a
 * sequential CPU loop versus a data-parallel compute kernel with no
 * inherent ordering) - mirroring `MotionBlurEffectConfig`'s own precedent
 * that a WebGPU-only Three.js technique gets a deliberately separate,
 * simpler fallback rather than a shared abstraction bent to fit both. Both
 * independently satisfy the same determinism requirement: the same
 * `(node, seed, frame)` always produces the same result, regardless of
 * evaluation history.
 *
 * Ready-to-upload per-particle data: `positions` (vec3 per slot),
 * `colors` (vec4 per slot, already resolved from `colorOverLife` at the
 * particle's own current age), and `sizes` (already resolved from
 * `sizeOverLife`, scaled by the particle's own jittered `startSize`, and
 * exactly `0` for a dead or never-yet-spawned slot - the mechanism that
 * makes an inert slot invisible without the renderer needing its own
 * separate "is this slot alive" check).
 */
export interface ParticleSimulationState {
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  readonly sizes: Float32Array;
}

/** Steps a particle system's CPU simulation forward (or resets and re-simulates on a backward seek) to a target frame. */
export interface ParticleCpuSimulation {
  /**
   * Advances the simulation to `frame` and returns its resulting per-particle
   * render data. Requesting the current frame again returns the cached
   * result without re-stepping; requesting an earlier frame than the last
   * one resets and re-simulates from frame 0 (mirrors `@cadra/physics`'s
   * `PhysicsBake.advanceTo`, for the identical reason: particle state is
   * sequential and history-dependent, so an earlier frame cannot be derived
   * from a later one without starting over).
   */
  advanceTo(frame: number): ParticleSimulationState;
}

interface MutableSimState {
  positions: Float32Array;
  velocities: Float32Array;
  ages: Float32Array;
  lifetimes: Float32Array;
  startSizes: Float32Array;
  spawnCursor: number;
  emissionAccumulator: number;
}

/** Whether ring-buffer slot `index` falls within the `count` slots starting at `start`, wrapping modulo `max`. */
function isInRingRange(index: number, start: number, count: number, max: number): boolean {
  if (count <= 0) {
    return false;
  }
  if (count >= max) {
    return true;
  }
  const offset = (index - start + max) % max;
  return offset < count;
}

function readVector3(array: Float32Array, index: number): Vector3 {
  // Typed-array element access is always a `number` at these in-bounds
  // indices (0 for any not-yet-written slot); `noUncheckedIndexedAccess`
  // types every indexed access as possibly `undefined` regardless of the
  // array kind, which does not apply to typed arrays the way it does to
  // sparse plain arrays.
  return [array[index * 3] as number, array[index * 3 + 1] as number, array[index * 3 + 2] as number];
}

function writeVector3(array: Float32Array, index: number, value: Vector3): void {
  array[index * 3] = value[0];
  array[index * 3 + 1] = value[1];
  array[index * 3 + 2] = value[2];
}

/** A single typed-array element read, asserted `number` for the same reason `readVector3` does. */
function at(array: Float32Array, index: number): number {
  return array[index] as number;
}

/**
 * Creates a CPU particle simulation for one `ParticleSystemNode`, seeded
 * deterministically from `numericSeed` (the composition's own frame seed,
 * already normalized via `toNumericSeed`) combined with the node's own
 * `seed` and `id`-derived `emitterSeed`.
 */
export function createParticleCpuSimulation(
  node: ParticleSystemNode,
  numericSeed: number,
  emitterSeed: number,
  fps: number,
): ParticleCpuSimulation {
  const dt = 1 / fps;
  const maxParticles = node.maxParticles;
  const baseDirection = normalizeOrZero(node.direction);

  let state: MutableSimState;
  let currentFrame = 0;
  let lastResult: ParticleSimulationState | undefined;

  function setupState(): void {
    state = {
      positions: new Float32Array(maxParticles * 3),
      velocities: new Float32Array(maxParticles * 3),
      ages: new Float32Array(maxParticles),
      lifetimes: new Float32Array(maxParticles),
      startSizes: new Float32Array(maxParticles),
      spawnCursor: 0,
      emissionAccumulator: 0,
    };
    currentFrame = 0;
    lastResult = undefined;
  }

  function respawn(index: number, frame: number): void {
    const spawnPosition = sampleEmitterShape(node.shape, numericSeed, emitterSeed, index, frame, 0);
    writeVector3(state.positions, index, spawnPosition);

    const speedVariance = node.initialSpeedVariance ?? 0;
    const speedJitter = particleHashSigned(numericSeed, emitterSeed, index, frame, 20);
    const speed = node.initialSpeed * (1 + speedJitter * speedVariance);

    const direction = jitterDirection(
      baseDirection,
      node.spreadAngle ?? 0,
      numericSeed,
      emitterSeed,
      index,
      frame,
      21,
    );
    writeVector3(state.velocities, index, [direction[0] * speed, direction[1] * speed, direction[2] * speed]);

    state.ages[index] = 0;
    const lifetimeVariance = node.lifetimeVarianceSeconds ?? 0;
    const lifetimeJitter = particleHashSigned(numericSeed, emitterSeed, index, frame, 23);
    state.lifetimes[index] = Math.max(dt, node.lifetimeSeconds + lifetimeJitter * lifetimeVariance);

    const sizeVariance = node.sizeVariance ?? 0;
    const sizeJitter = particleHashSigned(numericSeed, emitterSeed, index, frame, 24);
    state.startSizes[index] = node.startSize * Math.max(0, 1 + sizeJitter * sizeVariance);
  }

  function simulateLive(index: number): void {
    const position = readVector3(state.positions, index);
    const velocity = readVector3(state.velocities, index);
    const acceleration = computeAcceleration(
      node.forces,
      position,
      velocity,
      numericSeed,
      emitterSeed,
      at(state.ages, index),
    );

    const steppedVelocity: Vector3 = [
      velocity[0] + acceleration[0] * dt,
      velocity[1] + acceleration[1] * dt,
      velocity[2] + acceleration[2] * dt,
    ];
    const steppedPosition: Vector3 = [
      position[0] + steppedVelocity[0] * dt,
      position[1] + steppedVelocity[1] * dt,
      position[2] + steppedVelocity[2] * dt,
    ];

    const resolved = applyColliders(node.colliders, steppedPosition, steppedVelocity);
    writeVector3(state.positions, index, resolved.position);
    writeVector3(state.velocities, index, resolved.velocity);
    state.ages[index] = at(state.ages, index) + dt;
  }

  function stepOnce(frame: number): void {
    // Demand is capped at one full pool's worth per step: if sustained
    // emissionRate oversubscribes maxParticles (more wants to spawn per
    // second than the pool, sized for emissionRate * lifetimeSeconds
    // concurrent particles, can hold), excess demand is dropped rather than
    // queued. Without this cap, unfulfilled demand would accumulate
    // unboundedly while the pool stays full, then dump a large,
    // unrepresentative burst once slots finally free up.
    state.emissionAccumulator = Math.min(state.emissionAccumulator + node.emissionRate * dt, maxParticles);
    const spawnCount = Math.min(maxParticles, Math.floor(state.emissionAccumulator));
    state.emissionAccumulator -= spawnCount;

    const spawnStart = state.spawnCursor;
    state.spawnCursor = (state.spawnCursor + spawnCount) % maxParticles;

    for (let i = 0; i < maxParticles; i += 1) {
      if (isInRingRange(i, spawnStart, spawnCount, maxParticles)) {
        respawn(i, frame);
      } else if (at(state.ages, i) < at(state.lifetimes, i)) {
        simulateLive(i);
      }
    }
  }

  function computeRenderState(): ParticleSimulationState {
    const colors = new Float32Array(maxParticles * 4);
    const sizes = new Float32Array(maxParticles);

    for (let i = 0; i < maxParticles; i += 1) {
      const age = at(state.ages, i);
      const lifetime = at(state.lifetimes, i);
      const isAlive = lifetime > 0 && age < lifetime;
      if (!isAlive) {
        sizes[i] = 0;
        continue;
      }

      const t = age / lifetime;
      const color = resolveColorOverLife(node.colorOverLife, t);
      colors[i * 4] = color[0];
      colors[i * 4 + 1] = color[1];
      colors[i * 4 + 2] = color[2];
      colors[i * 4 + 3] = color[3];
      sizes[i] = at(state.startSizes, i) * resolveSizeOverLife(node.sizeOverLife, t);
    }

    return { positions: state.positions, colors, sizes };
  }

  setupState();

  return {
    advanceTo(frame: number): ParticleSimulationState {
      if (frame === currentFrame && lastResult !== undefined) {
        return lastResult;
      }
      if (frame < currentFrame) {
        setupState();
      }
      while (currentFrame < frame) {
        currentFrame += 1;
        stepOnce(currentFrame);
      }
      lastResult = computeRenderState();
      return lastResult;
    },
  };
}
