/**
 * @cadra/particles
 *
 * Deterministic GPU particle systems (Phase 67): a WebGPU compute path
 * (TSL storage buffers, GPU-resident state, scales to large counts) and a
 * CPU-simulated WebGL2 fallback, both implementing the same emitter/force/
 * collider/lifetime rules seeded deterministically per composition, per
 * emitter, and per particle slot.
 */

export { applyColliders } from "./colliders.js";
export {
  DEFAULT_PARTICLE_COLOR,
  DEFAULT_PARTICLE_SIZE_MULTIPLIER,
  resolveColorOverLife,
  resolveSizeOverLife,
} from "./color-size-curves.js";
export type { CpuParticleObject } from "./cpu-particle-object.js";
export { createCpuParticleObject } from "./cpu-particle-object.js";
export type { ParticleCpuSimulation, ParticleSimulationState } from "./cpu-simulation.js";
export { createParticleCpuSimulation } from "./cpu-simulation.js";
export { curlNoise3D, valueNoise3D } from "./curl-noise.js";
export { jitterDirection } from "./direction-jitter.js";
export { sampleEmitterShape } from "./emitter-shape.js";
export { computeAcceleration } from "./forces.js";
export type { ComputeDispatchable, GpuParticleSystem } from "./gpu-particle-system.js";
export { createGpuParticleSystem } from "./gpu-particle-system.js";
export { particleHash, particleHashSigned } from "./hash.js";
export type { ComputeFn, ParticleRuntime, ParticleRuntimeDependencies } from "./particle-runtime.js";
export { createParticleRuntime } from "./particle-runtime.js";
export { curlNoise3DTSL, valueNoise3DTSL } from "./tsl-curl-noise.js";
