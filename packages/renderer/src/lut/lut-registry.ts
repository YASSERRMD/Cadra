import * as THREE from "three";

import { applyColorGrade } from "../post-processing/color-grade.js";

/**
 * Resolves a `LutEffectConfig.lutRef` to a shared, real
 * `THREE.Data3DTexture` (already in `LUTCubeLoader`'s own exact data
 * layout: `((b * size + g) * size + r) * 4 + channel`, `.cube`'s own
 * documented convention of red varying fastest, so a resolved value here is
 * indistinguishable, from `LUTPass`/`Lut3DNode`'s own point of view, from
 * one `LUTCubeLoader.parse` produced). Implementations pool textures across
 * every composition that references the same id, mirroring
 * `EnvironmentRegistry`'s own "never dispose what a registry returns"
 * contract.
 */
export interface LutRegistry {
  resolve(ref: string): THREE.Data3DTexture | undefined;
}

/** Ids the default LUT registry seeds itself with. */
export const DEFAULT_LUT_REFS = ["warm", "tealOrange", "filmStock"] as const;

/**
 * Grid resolution for the built-in procedural LUTs: `.cube` files commonly
 * ship `17` or `33` (an odd size so the grid lands exactly on `0.5`, the
 * pivot `applyColorGrade`'s own contrast term uses), and `17` keeps these
 * three built-ins small and fast to generate with no visible banding for
 * the gentle look transforms below.
 */
const LUT_SIZE = 17;

/**
 * Builds a real `THREE.Data3DTexture` by sampling `lookAt` (a pure function
 * from a normalized `[0, 1]` input color to its own graded output) across a
 * `size`-cubed grid, in `LUTCubeLoader`'s own exact data layout (see
 * `LutRegistry`'s own doc). Deterministically: no `Math.random()`/
 * `Date.now()`, so a given `lookAt` always produces byte-identical texture
 * data, mirroring `environment-registry.ts`'s own
 * `renderEquirectangularTexture` pattern for the exact same reason.
 */
function buildLutTexture(
  size: number,
  lookAt: (r: number, g: number, b: number) => readonly [number, number, number],
): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  for (let b = 0; b < size; b += 1) {
    const bIn = b / (size - 1);
    for (let g = 0; g < size; g += 1) {
      const gIn = g / (size - 1);
      for (let r = 0; r < size; r += 1) {
        const rIn = r / (size - 1);
        const [rOut, gOut, bOut] = lookAt(rIn, gIn, bIn);
        const index = ((b * size + g) * size + r) * 4;
        data[index] = Math.round(clamp01(rOut) * 255);
        data[index + 1] = Math.round(clamp01(gOut) * 255);
        data[index + 2] = Math.round(clamp01(bOut) * 255);
        data[index + 3] = 255;
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.type = THREE.UnsignedByteType;
  texture.format = THREE.RGBAFormat;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** A gentle, uniform warm-white-balance-style push: brighter, warmer highlights via `applyColorGrade`'s own gain and lift. */
function warmLookAt(r: number, g: number, b: number): readonly [number, number, number] {
  const graded = applyColorGrade({ r, g, b }, [0.015, 0.005, -0.01], [1, 1, 1], [1.08, 1.02, 0.92], 1.05, 1);
  return [graded.r, graded.g, graded.b];
}

/**
 * The classic "teal shadows, orange highlights" blockbuster grade: a
 * luma-dependent hue push (teal/cyan pulled into dark tones, orange pushed
 * into bright ones) that a uniform per-channel lift/gain cannot express on
 * its own - exactly the kind of look a 3D LUT exists for.
 */
function tealOrangeLookAt(r: number, g: number, b: number): readonly [number, number, number] {
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const shadowPull = 1 - luma;
  const highlightPush = luma;
  const teal: readonly [number, number, number] = [-0.04, 0.01, 0.05];
  const orange: readonly [number, number, number] = [0.08, 0.03, -0.05];
  return [
    r + teal[0] * shadowPull + orange[0] * highlightPush,
    g + teal[1] * shadowPull + orange[1] * highlightPush,
    b + teal[2] * shadowPull + orange[2] * highlightPush,
  ];
}

/** A subtle film-emulation look: gently lifted blacks, softened highlights, and a light desaturation, via `applyColorGrade`. */
function filmStockLookAt(r: number, g: number, b: number): readonly [number, number, number] {
  const graded = applyColorGrade({ r, g, b }, [0.03, 0.025, 0.02], [1.05, 1.05, 1.05], [0.97, 0.97, 0.95], 0.9, 0.95);
  return [graded.r, graded.g, graded.b];
}

/**
 * A simple in-memory `LutRegistry` seeded with three procedurally generated
 * 3D LUTs, `"warm"`, `"tealOrange"`, and `"filmStock"`, mirroring
 * `createDefaultEnvironmentRegistry`'s own purpose: real, working, zero-
 * config looks, not placeholders that wait on a future asset pipeline or a
 * real `.cube` file. Real `.cube` files (via `parseCubeLut`/
 * `loadLutFromCube`) populate a caller's own custom `LutRegistry` instead,
 * the same split `hdr-environment-loader.ts` already establishes for real
 * HDR environment files versus `createDefaultEnvironmentRegistry`'s own
 * procedural built-ins.
 */
export function createDefaultLutRegistry(): LutRegistry {
  const luts = new Map<string, THREE.Data3DTexture>([
    ["warm", buildLutTexture(LUT_SIZE, warmLookAt)],
    ["tealOrange", buildLutTexture(LUT_SIZE, tealOrangeLookAt)],
    ["filmStock", buildLutTexture(LUT_SIZE, filmStockLookAt)],
  ]);

  return {
    resolve(ref: string): THREE.Data3DTexture | undefined {
      return luts.get(ref);
    },
  };
}
