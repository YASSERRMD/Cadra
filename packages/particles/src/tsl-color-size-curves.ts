import type { ParticleColorStop, ParticleSizeStop } from "@cadra/core";
import { clamp, float, mix, vec4 } from "three/tsl";
import type { Node } from "three/webgpu";

import { DEFAULT_PARTICLE_COLOR, DEFAULT_PARTICLE_SIZE_MULTIPLIER } from "./color-size-curves.js";

/**
 * TSL port of `./color-size-curves.ts`, for the WebGPU compute/render path.
 * `stops` is always static per-emitter config (known at shader-graph
 * construction time), so the bracket search itself is unrolled into a fixed
 * left-to-right chain of GPU `select`s at construction time - only `t` (a
 * particle's own current lifetime fraction, read from its age/lifetime
 * buffers) is a genuine runtime node.
 *
 * The chain walks stops left to right, each step overwriting the running
 * result once `t` has passed that stop's own `time` - so the last stop
 * whose `time` is at or before `t` "wins", naturally clamping to the first
 * stop's own value before it and the last stop's own value beyond it,
 * without needing a separate "is t inside this bracket" check.
 */

function sortedByTime<Stop extends { time: number }>(stops: readonly Stop[]): Stop[] {
  return [...stops].sort((a, b) => a.time - b.time);
}

export function resolveColorOverLifeTSL(
  stops: readonly ParticleColorStop[] | undefined,
  t: Node<"float">,
): Node<"vec4"> {
  if (stops === undefined || stops.length === 0) {
    return vec4(...DEFAULT_PARTICLE_COLOR) as Node<"vec4">;
  }

  const sorted = sortedByTime(stops);
  const first = sorted[0] as ParticleColorStop;
  if (sorted.length === 1) {
    return vec4(...first.color) as Node<"vec4">;
  }

  let result = vec4(...first.color) as Node<"vec4">;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    // Safe: i ranges over [0, sorted.length - 2], so both indices are in bounds.
    const start = sorted[i] as ParticleColorStop;
    const end = sorted[i + 1] as ParticleColorStop;
    const span = end.time - start.time;
    const localT =
      span === 0 ? float(0) : (clamp(t.sub(start.time).div(span), float(0), float(1)) as Node<"float">);
    const lerped = mix(vec4(...start.color), vec4(...end.color), localT) as Node<"vec4">;
    result = t.greaterThan(start.time).select(lerped, result) as Node<"vec4">;
  }
  return result;
}

export function resolveSizeOverLifeTSL(
  stops: readonly ParticleSizeStop[] | undefined,
  t: Node<"float">,
): Node<"float"> {
  if (stops === undefined || stops.length === 0) {
    return float(DEFAULT_PARTICLE_SIZE_MULTIPLIER) as Node<"float">;
  }

  const sorted = sortedByTime(stops);
  const first = sorted[0] as ParticleSizeStop;
  if (sorted.length === 1) {
    return float(first.size) as Node<"float">;
  }

  let result = float(first.size) as Node<"float">;
  for (let i = 0; i < sorted.length - 1; i += 1) {
    // Safe: i ranges over [0, sorted.length - 2], so both indices are in bounds.
    const start = sorted[i] as ParticleSizeStop;
    const end = sorted[i + 1] as ParticleSizeStop;
    const span = end.time - start.time;
    const localT =
      span === 0 ? float(0) : (clamp(t.sub(start.time).div(span), float(0), float(1)) as Node<"float">);
    const lerped = mix(float(start.size), float(end.size), localT) as Node<"float">;
    result = t.greaterThan(start.time).select(lerped, result) as Node<"float">;
  }
  return result;
}
