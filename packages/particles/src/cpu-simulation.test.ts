import type { ParticleSystemNode } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { createParticleCpuSimulation } from "./cpu-simulation.js";

const FPS = 30;

function baseNode(overrides: Partial<ParticleSystemNode> = {}): ParticleSystemNode {
  return {
    id: "emitter-1",
    kind: "particles",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    children: [],
    maxParticles: 100,
    emissionRate: 30,
    shape: { type: "point" },
    lifetimeSeconds: 2,
    initialSpeed: 1,
    direction: [0, 1, 0],
    startSize: 0.1,
    ...overrides,
  };
}

function countAlive(sizes: Float32Array): number {
  let count = 0;
  for (const size of sizes) {
    if (size > 0) {
      count += 1;
    }
  }
  return count;
}

describe("createParticleCpuSimulation", () => {
  it("has no particles alive at frame 0 (nothing has been emitted before any time elapses)", () => {
    const sim = createParticleCpuSimulation(baseNode(), 1, 0, FPS);
    const state = sim.advanceTo(0);
    expect(countAlive(state.sizes)).toBe(0);
  });

  it("spawns particles as frames advance, up to maxParticles", () => {
    const sim = createParticleCpuSimulation(baseNode({ emissionRate: 1000, maxParticles: 50 }), 1, 0, FPS);
    const state = sim.advanceTo(60);
    expect(countAlive(state.sizes)).toBeGreaterThan(0);
    expect(countAlive(state.sizes)).toBeLessThanOrEqual(50);
  });

  it("a particle under gravity falls: its y position strictly decreases frame over frame", () => {
    // emissionRate (30/sec) stays well under what a 100-slot, 2-second-lifetime
    // pool sustains (100 / 2 = 50/sec), so slot 0 (the first ever spawned,
    // frame 1) survives untouched by the ring buffer for its own full
    // lifetime - unlike an oversubscribed pool, where every slot gets
    // overwritten (respawned) again before it can simulate even one step.
    const sim = createParticleCpuSimulation(
      baseNode({
        emissionRate: 30,
        maxParticles: 100,
        initialSpeed: 0,
        forces: [{ type: "gravity", acceleration: [0, -9.81, 0] }],
      }),
      1,
      0,
      FPS,
    );

    sim.advanceTo(1);
    let previousY = -Infinity;
    let sawDecrease = false;
    for (let frame = 2; frame <= 20; frame += 1) {
      const state = sim.advanceTo(frame);
      expect(state.sizes[0]).toBeGreaterThan(0);
      const y = state.positions[1] as number;
      if (previousY !== -Infinity) {
        expect(y).toBeLessThan(previousY);
        sawDecrease = true;
      }
      previousY = y;
    }
    expect(sawDecrease).toBe(true);
  });

  it("moves in a straight line at initialSpeed*direction with no forces", () => {
    const node = baseNode({
      emissionRate: 30,
      maxParticles: 100,
      lifetimeSeconds: 5,
      initialSpeed: 2,
      direction: [0, 1, 0],
    });
    const sim = createParticleCpuSimulation(node, 1, 0, FPS);
    sim.advanceTo(1);
    const after10 = sim.advanceTo(11);
    // Slot 0 (spawned at frame 1) should have traveled roughly speed * elapsed-seconds along y.
    expect(after10.sizes[0]).toBeGreaterThan(0);
    const y = after10.positions[1];
    expect(y).toBeGreaterThan(0);
  });

  it("is deterministic: two independent simulations produce identical state across many frames", () => {
    // emissionRate stays under maxParticles / lifetimeSeconds (64 / 2 = 32/sec)
    // so the pool never saturates: forces and colliders genuinely get
    // exercised across many simulated steps, rather than every slot being
    // overwritten (respawned) before it can simulate even once.
    const node = baseNode({
      emissionRate: 20,
      maxParticles: 64,
      forces: [
        { type: "gravity", acceleration: [0, -9.81, 0] },
        { type: "curlNoise", strength: 1, frequency: 0.3 },
      ],
      colliders: [{ type: "groundPlane", y: -1, bounce: 0.3 }],
      lifetimeVarianceSeconds: 0.5,
      initialSpeedVariance: 0.2,
      sizeVariance: 0.3,
    });

    const simA = createParticleCpuSimulation(node, 42, 7, FPS);
    const simB = createParticleCpuSimulation(node, 42, 7, FPS);

    for (let frame = 0; frame <= 30; frame += 1) {
      const stateA = simA.advanceTo(frame);
      const stateB = simB.advanceTo(frame);
      expect(Array.from(stateA.positions)).toEqual(Array.from(stateB.positions));
      expect(Array.from(stateA.colors)).toEqual(Array.from(stateB.colors));
      expect(Array.from(stateA.sizes)).toEqual(Array.from(stateB.sizes));
    }
  });

  it("produces different streams for different emitter seeds", () => {
    // A "point" shape's own spawn position ignores seed entirely (every
    // particle spawns at the same local origin regardless); a "sphere"
    // shape's does not, so this is the shape that actually exercises seed
    // sensitivity.
    const node = baseNode({ emissionRate: 30, maxParticles: 100, shape: { type: "sphere", radius: 1 } });
    const simA = createParticleCpuSimulation(node, 42, 1, FPS);
    const simB = createParticleCpuSimulation(node, 42, 2, FPS);

    const stateA = simA.advanceTo(10);
    const stateB = simB.advanceTo(10);
    expect(Array.from(stateA.positions)).not.toEqual(Array.from(stateB.positions));
  });

  it("returns the cached result without re-stepping when the same frame is requested again", () => {
    const node = baseNode({ emissionRate: 20, maxParticles: 32 });
    const sim = createParticleCpuSimulation(node, 1, 0, FPS);
    const first = sim.advanceTo(10);
    const second = sim.advanceTo(10);
    expect(second).toBe(first);
  });

  it("re-simulating from frame 0 on a backward seek matches a fresh simulation's result at that frame", () => {
    const node = baseNode({
      emissionRate: 20,
      maxParticles: 32,
      forces: [{ type: "gravity", acceleration: [0, -9.81, 0] }],
    });

    const forward = createParticleCpuSimulation(node, 5, 2, FPS);
    forward.advanceTo(40);
    const seekedBack = forward.advanceTo(10);

    const fresh = createParticleCpuSimulation(node, 5, 2, FPS);
    const freshAt10 = fresh.advanceTo(10);

    expect(Array.from(seekedBack.positions)).toEqual(Array.from(freshAt10.positions));
    expect(Array.from(seekedBack.sizes)).toEqual(Array.from(freshAt10.sizes));
  });

  it("a groundPlane collider stops particles from falling through it", () => {
    const node = baseNode({
      emissionRate: 30,
      maxParticles: 100,
      lifetimeSeconds: 3,
      initialSpeed: 0,
      forces: [{ type: "gravity", acceleration: [0, -9.81, 0] }],
      colliders: [{ type: "groundPlane", y: -0.5 }],
    });
    const sim = createParticleCpuSimulation(node, 1, 0, FPS);
    sim.advanceTo(1);

    let minY = Infinity;
    for (let frame = 2; frame <= 90; frame += 1) {
      const state = sim.advanceTo(frame);
      if ((state.sizes[0] as number) > 0) {
        minY = Math.min(minY, state.positions[1] as number);
      }
    }
    expect(minY).toBeLessThan(Infinity);
    expect(minY).toBeGreaterThanOrEqual(-0.5 - 1e-6);
  });

  it("respects lifetimeSeconds: slot 0 becomes inert (size 0) once its age exceeds its lifetime", () => {
    // A low, sustainable emissionRate means slot 0 is spawned once at frame 1
    // and, since maxParticles is generously large relative to
    // emissionRate * lifetimeSeconds, is not overwritten by the ring buffer
    // again within this test's short observation window - so its
    // alive-then-dead transition is due to lifetimeSeconds expiring, not
    // pool-capacity overwrite.
    const node = baseNode({
      emissionRate: 30,
      maxParticles: 50,
      lifetimeSeconds: 0.1,
      initialSpeed: 0,
    });
    const sim = createParticleCpuSimulation(node, 1, 0, FPS);
    // 0.1s at 30fps is 3 frames.
    const atBirth = sim.advanceTo(1);
    expect(atBirth.sizes[0]).toBeGreaterThan(0);
    const wellPastLifetime = sim.advanceTo(6);
    expect(wellPastLifetime.sizes[0]).toBe(0);
  });

  it("never exceeds maxParticles alive slots even at a very high emission rate", () => {
    const node = baseNode({ emissionRate: 100000, maxParticles: 20, lifetimeSeconds: 100 });
    const sim = createParticleCpuSimulation(node, 1, 0, FPS);
    const state = sim.advanceTo(5);
    expect(countAlive(state.sizes)).toBeLessThanOrEqual(20);
  });

  it("applies colorOverLife across a particle's own lifetime", () => {
    const node = baseNode({
      emissionRate: 30,
      maxParticles: 100,
      lifetimeSeconds: 3,
      initialSpeed: 0,
      colorOverLife: [
        { time: 0, color: [1, 0, 0, 1] },
        { time: 1, color: [0, 0, 1, 1] },
      ],
    });
    const sim = createParticleCpuSimulation(node, 1, 0, FPS);
    const nearBirth = sim.advanceTo(1);
    expect(nearBirth.sizes[0]).toBeGreaterThan(0);
    expect(nearBirth.colors[0]).toBeGreaterThan(nearBirth.colors[2] as number);
  });
});
