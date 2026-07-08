import type { ParticleSystemNode } from "@cadra/core";
import * as THREE from "three";

import type { ParticleSimulationState } from "./cpu-simulation.js";

/**
 * The WebGL2 fallback's renderable object (Phase 67): a classic
 * `THREE.Points` draw, with `size`/`particleColor` as ordinary per-vertex
 * `BufferAttribute`s the CPU simulation's own output arrays are copied into
 * each frame. A raw `THREE.ShaderMaterial`, not a `THREE.PointsMaterial`:
 * `PointsMaterial.size` is a single uniform (one size for every point in
 * the draw call), with no way to vary it per particle - exactly the same
 * "no per-vertex sizeNode-equivalent" gap `sizeOverLife` needs a classic
 * material to fill.
 */

const VERTEX_SHADER = `
  attribute float size;
  attribute vec4 particleColor;
  varying vec4 vColor;
  void main() {
    vColor = particleColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const FRAGMENT_SHADER = `
  varying vec4 vColor;
  #ifdef HAS_MAP
  uniform sampler2D map;
  #endif
  void main() {
    vec4 texColor;
    #ifdef HAS_MAP
    texColor = texture2D(map, gl_PointCoord);
    #else
    vec2 centered = gl_PointCoord - vec2(0.5);
    float dist = length(centered) * 2.0;
    float alpha = 1.0 - smoothstep(0.8, 1.0, dist);
    texColor = vec4(1.0, 1.0, 1.0, alpha);
    #endif
    vec4 finalColor = texColor * vColor;
    if (finalColor.a < 0.001) discard;
    gl_FragColor = finalColor;
  }
`;

export interface CpuParticleObject {
  readonly object3D: THREE.Object3D;
  /** Copies a freshly-simulated frame's per-particle data into this object's own render buffers. */
  update(state: ParticleSimulationState): void;
  dispose(): void;
}

export function createCpuParticleObject(
  node: ParticleSystemNode,
  resolveTexture?: (ref: string) => THREE.Texture | undefined,
): CpuParticleObject {
  const maxParticles = node.maxParticles;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(maxParticles * 3), 3));
  geometry.setAttribute("particleColor", new THREE.BufferAttribute(new Float32Array(maxParticles * 4), 4));
  geometry.setAttribute("size", new THREE.BufferAttribute(new Float32Array(maxParticles), 1));

  const resolvedTexture = node.textureRef !== undefined ? resolveTexture?.(node.textureRef) : undefined;

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: node.blendMode === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
    defines: resolvedTexture !== undefined ? { HAS_MAP: "" } : {},
    uniforms: resolvedTexture !== undefined ? { map: { value: resolvedTexture } } : {},
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    object3D: points,

    update(state: ParticleSimulationState): void {
      const positionAttribute = geometry.attributes.position as THREE.BufferAttribute;
      (positionAttribute.array as Float32Array).set(state.positions);
      positionAttribute.needsUpdate = true;

      const colorAttribute = geometry.attributes.particleColor as THREE.BufferAttribute;
      (colorAttribute.array as Float32Array).set(state.colors);
      colorAttribute.needsUpdate = true;

      const sizeAttribute = geometry.attributes.size as THREE.BufferAttribute;
      (sizeAttribute.array as Float32Array).set(state.sizes);
      sizeAttribute.needsUpdate = true;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
