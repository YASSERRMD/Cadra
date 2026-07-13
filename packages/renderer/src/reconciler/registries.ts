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

/**
 * Resolves a `MeshMaterialConfig.normalMapRef`/`.aoMapRef` to a shared
 * `THREE.Texture` instance. Same pooling and non-disposal contract as
 * `GeometryRegistry`: a texture resolved here is never disposed by the
 * reconciler (see `node-factory.ts`'s own PBR material construction), only
 * whatever populated the registry owns that lifetime.
 *
 * Phase 12's asset pipeline is the intended long-term implementation of this
 * interface, same as `GeometryRegistry`/`MaterialRegistry`;
 * `createDefaultTextureRegistry` below seeds nothing at all (no texture
 * asset exists to seed it with yet), so every `resolve` call returns
 * `undefined` until a real registry is injected - a harmless, documented
 * no-op (a mesh's `normalMap`/`aoMap` simply stay unset), not an error.
 */
export interface TextureRegistry {
  resolve(ref: string): THREE.Texture | undefined;
}

/** Ids the default geometry registry seeds itself with. */
export const DEFAULT_GEOMETRY_REFS = ["box", "sphere", "plane", "torus", "cylinder", "cone"] as const;

/** Ids the default material registry seeds itself with. */
export const DEFAULT_MATERIAL_REFS = ["default", "wireframe"] as const;

/**
 * A simple in-memory `GeometryRegistry` seeded with a handful of common
 * primitives, so tests (and early authoring) can exercise real mesh
 * reconciliation without waiting on Phase 12's real asset pipeline. Every
 * call to `resolve` with a seeded ref returns the exact same shared
 * instance. `"plane"` is unit-sized (`1x1`, same "scale it via the node's
 * own `transform.scale`" convention `"box"`'s `BoxGeometry(1, 1, 1)`
 * already establishes), facing `+Z` (`THREE.PlaneGeometry`'s own default
 * orientation) - the same orientation a camera at a positive `Z` position
 * looking toward the origin (every curated example's own camera convention)
 * already faces. `"torus"`/`"cylinder"`/`"cone"` use the same dimensions
 * `MeshGeometryConfig`'s own `buildProceduralGeometry` (`../reconciler/
 * node-factory.ts`) defaults to for each shape, so a `geometryRef` naming
 * one of these and an equivalent bare `{ type: "..." }` inline `geometry`
 * produce the same shape.
 */
export function createDefaultGeometryRegistry(): GeometryRegistry {
  const geometries = new Map<string, THREE.BufferGeometry>([
    ["box", new THREE.BoxGeometry(1, 1, 1)],
    ["sphere", new THREE.SphereGeometry(0.5, 16, 12)],
    ["plane", new THREE.PlaneGeometry(1, 1)],
    ["torus", new THREE.TorusGeometry(0.4, 0.15, 12, 24)],
    ["cylinder", new THREE.CylinderGeometry(0.5, 0.5, 1, 16)],
    ["cone", new THREE.ConeGeometry(0.5, 1, 16)],
  ]);

  return {
    resolve(ref: string): THREE.BufferGeometry | undefined {
      return geometries.get(ref);
    },
  };
}

/**
 * A simple in-memory `MaterialRegistry` seeded with a couple of basic
 * materials, mirroring `createDefaultGeometryRegistry`'s purpose. `"default"`
 * uses a cinematic `roughness: 0.7` (Three.js's own `MeshStandardMaterial`
 * default is a fully matte `1`) so an unstyled mesh already reads as a
 * plausible surface, not a flat, lifeless one.
 */
export function createDefaultMaterialRegistry(): MaterialRegistry {
  const materials = new Map<string, THREE.Material>([
    ["default", new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.7 })],
    ["wireframe", new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true })],
  ]);

  return {
    resolve(ref: string): THREE.Material | undefined {
      return materials.get(ref);
    },
  };
}

/**
 * A `TextureRegistry` that resolves nothing at all: the default when no real
 * texture registry is injected. See `TextureRegistry`'s own doc for why an
 * always-empty default is a safe, documented no-op rather than an error.
 */
export function createDefaultTextureRegistry(): TextureRegistry {
  return {
    resolve(): THREE.Texture | undefined {
      return undefined;
    },
  };
}

/** A `TextureRegistry` a caller can also populate. Mirrors `MutableTextRenderRegistry`'s own shape (`../text/text-render-registry.ts`). */
export interface MutableTextureRegistry extends TextureRegistry {
  register(ref: string, texture: THREE.Texture): void;
}

/**
 * A simple in-memory `MutableTextureRegistry`, backed by a `Map`. Unlike
 * `createDefaultGeometryRegistry`/`createDefaultMaterialRegistry`, this
 * seeds nothing on its own (there is no meaningful "default" texture to seed
 * with, mirroring `createDefaultTextureRegistry`'s own empty default) - a
 * caller populates it via `register`, e.g. once per resolved `ImageNode`
 * asset, the same way `createInMemoryTextRenderRegistry` gets populated once
 * per resolved `TextNode`.
 */
export function createInMemoryTextureRegistry(): MutableTextureRegistry {
  const textures = new Map<string, THREE.Texture>();

  return {
    resolve(ref: string): THREE.Texture | undefined {
      return textures.get(ref);
    },
    register(ref: string, texture: THREE.Texture): void {
      textures.set(ref, texture);
    },
  };
}

/**
 * Wraps an already-decoded `ImageBitmap` (a browser's own `createImageBitmap`
 * result) into a `THREE.Texture` ready for a `TextureRegistry` to serve,
 * mirroring `../svg-layer/create-svg-texture.ts`'s own "browser-decoded
 * resource to GPU-ready texture" purpose for the image-asset case instead of
 * the rasterized-SVG one. Lives here (not `../assets/image-loader.ts`,
 * where `ImageBitmap` decoding itself is defined) because `image-loader.ts`
 * is part of this package's Three.js-free `Renderer`-facing public surface
 * (see `index.test.ts`'s own "no Three.js leakage" guard), while this
 * `./reconciler` module is explicitly exempt: its whole point is producing
 * real Three.js values.
 *
 * `colorSpace` is set to `THREE.SRGBColorSpace`: an uploaded image asset's
 * bytes are real, visible sRGB-gamma-encoded color (the same reasoning
 * `createSvgTexture` documents for its own rasterized pixels), not a
 * colorless data channel. `flipY` is left at `THREE.Texture`'s own default
 * (`true`): unlike `createSvgTexture`'s `THREE.DataTexture` (whose default
 * is `false`, since a raw pixel buffer has no browser-decoder-imposed
 * orientation convention of its own), an `ImageBitmap`-backed `THREE.Texture`
 * is the standard, idiomatic way Three.js loads a photo/image texture, and
 * changing this default would fight that convention rather than match it.
 */
export function createImageTexture(image: ImageBitmap): THREE.Texture {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Wraps an already-decoded raw RGBA8 pixel buffer (e.g. `pngjs`'s own
 * `PNG.sync.read(bytes).data`, top-left-origin/top-down row order, same
 * convention as this codebase's own `PixelBuffer`) into a `THREE.Texture`
 * ready for a `TextureRegistry` to serve - the Node-only-decoder
 * counterpart to `createImageTexture`'s browser-only `createImageBitmap`
 * path, for a caller with no browser page to decode in at all (e.g.
 * `@cadra/headless`'s native-GPU-headless render path).
 *
 * `flipY: true` (unlike `createSvgTexture`'s own `THREE.DataTexture`,
 * which leaves `flipY` at Three.js's own `false` default): verified
 * empirically (a real two-tone top/bottom test image, rendered through a
 * real native GPU device and read back) that `pngjs`'s own decoded row
 * order needs this same top-down-to-GL-bottom-up flip `createImageTexture`
 * already needs for its own top-down `ImageBitmap` source, or the
 * rendered output comes out vertically mirrored - the same bug class
 * `../text/build-text-group.ts`'s own glyph-UV fix (P1) already fixed
 * once elsewhere in this codebase. `createSvgTexture`'s own rasterizer
 * evidently produces already-GL-ready row order instead; the two sources
 * are not interchangeable just because both are "a raw pixel buffer."
 */
export function createDataTexture(pixels: Uint8Array, width: number, height: number): THREE.Texture {
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
