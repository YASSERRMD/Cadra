import * as THREE from "three";

/**
 * Resolves a `CompositionEnvironment.envMapRef` to a shared, raw
 * equirectangular `THREE.Texture` (before PMREM prefiltering; see
 * `ThreeRendererLike.createEnvironmentMap` in `../three-renderer.ts`).
 * Implementations pool textures across every composition that references
 * the same id, so a caller must never dispose anything a registry returns:
 * only the registry (or whatever populated it) owns that lifetime, the same
 * contract `GeometryRegistry`/`MaterialRegistry`/`TextureRegistry` already
 * establish in `../reconciler/registries.ts`.
 */
export interface EnvironmentRegistry {
  resolve(ref: string): THREE.Texture | undefined;
}

/** Ids the default environment registry seeds itself with. */
export const DEFAULT_ENVIRONMENT_REFS = ["studio", "outdoor"] as const;

/**
 * Equirectangular texture dimensions for the built-in procedural
 * environments: `PMREMGenerator.fromEquirectangular`'s own doc states 64x32
 * as the smallest supported input size, which is also more than adequate
 * here since PMREM prefiltering blurs the result anyway (these are soft
 * lighting environments, not sharp visible backdrops with fine detail).
 */
const ENVIRONMENT_TEXTURE_WIDTH = 64;
const ENVIRONMENT_TEXTURE_HEIGHT = 32;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Distance from `(u, v)` to a soft round highlight centered at `(centerU,
 * centerV)`, wrapping around the seam at `u = 0`/`u = 1` (azimuth is
 * circular; a highlight near one edge must still glow across the seam onto
 * the other edge, not clip off abruptly).
 */
function radialFalloff(u: number, v: number, centerU: number, centerV: number, radius: number): number {
  const du = Math.min(Math.abs(u - centerU), 1 - Math.abs(u - centerU));
  const dv = v - centerV;
  const distance = Math.sqrt(du * du + dv * dv) / radius;
  return Math.max(0, 1 - distance);
}

/**
 * A soft, neutral three-point-ish studio lighting setup: a bright ceiling
 * fading to a darker floor, plus two soft rectangular "softbox" highlights
 * near the top, giving PBR materials believable specular direction without
 * looking like a flat gray box.
 */
function studioEnvironmentPixel(u: number, v: number): readonly [number, number, number] {
  const elevation = 1 - v;
  const base = 0.12 + elevation * 0.4;
  const softboxLeft = radialFalloff(u, v, 0.22, 0.18, 0.22) ** 2 * 1.4;
  const softboxRight = radialFalloff(u, v, 0.72, 0.18, 0.22) ** 2 * 1.4;
  const value = base + softboxLeft + softboxRight;
  // A hair of cool tint, matching a typical neutral studio light rather than a warm tungsten one.
  return [value, value, value * 1.03];
}

/**
 * A simple outdoor daylight sky: a warm horizon fading to a deep blue
 * zenith, a duller ground plane below the horizon, and one soft sun
 * highlight, giving directional specular reflections and a plausible
 * ambient sky color.
 */
function outdoorEnvironmentPixel(u: number, v: number): readonly [number, number, number] {
  const elevation = 1 - v;
  const skyR = lerp(0.85, 0.25, elevation);
  const skyG = lerp(0.82, 0.48, elevation);
  const skyB = lerp(0.72, 0.92, elevation);
  const groundR = 0.22;
  const groundG = 0.2;
  const groundB = 0.16;
  const groundBlend = Math.max(0, Math.min(1, (v - 0.5) * 4));
  const baseR = lerp(skyR, groundR, groundBlend);
  const baseG = lerp(skyG, groundG, groundBlend);
  const baseB = lerp(skyB, groundB, groundBlend);
  const sun = radialFalloff(u, v, 0.65, 0.22, 0.08) ** 3;
  return [baseR + sun * 4, baseG + sun * 3.6, baseB + sun * 2.8];
}

/**
 * Renders `pixelAt` (a pure function of normalized `(u, v)` equirectangular
 * coordinates, `u` = azimuth 0-1, `v` = elevation 0 at the zenith to 1 at
 * the nadir) into a real `THREE.DataTexture`, deterministically: no
 * `Math.random()`/`Date.now()`, so the same environment renders byte-
 * identical pixels every time this module is evaluated.
 */
function renderEquirectangularTexture(
  pixelAt: (u: number, v: number) => readonly [number, number, number],
): THREE.DataTexture {
  const width = ENVIRONMENT_TEXTURE_WIDTH;
  const height = ENVIRONMENT_TEXTURE_HEIGHT;
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const [r, g, b] = pixelAt(u, v);
      const index = (y * width + x) * 4;
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 1;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * A simple in-memory `EnvironmentRegistry` seeded with two procedurally
 * generated equirectangular environments, `"studio"` and `"outdoor"`,
 * mirroring `createDefaultGeometryRegistry`/`createDefaultMaterialRegistry`'s
 * own purpose: real, working, zero-config content, not a placeholder that
 * waits on a future asset pipeline. Procedural rather than loaded from a
 * real HDR/EXR file (see `hdr-environment-loader.ts` for that capability)
 * specifically so these two built-ins need no binary asset checked into
 * this repository at all, and render identically on every machine.
 */
export function createDefaultEnvironmentRegistry(): EnvironmentRegistry {
  const environments = new Map<string, THREE.Texture>([
    ["studio", renderEquirectangularTexture(studioEnvironmentPixel)],
    ["outdoor", renderEquirectangularTexture(outdoorEnvironmentPixel)],
  ]);

  return {
    resolve(ref: string): THREE.Texture | undefined {
      return environments.get(ref);
    },
  };
}
