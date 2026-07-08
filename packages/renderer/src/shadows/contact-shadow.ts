import * as THREE from "three";

/** Texture resolution for the procedural contact-shadow decal: a smooth radial gradient needs no fine detail, so this stays small and fast to (re)generate. */
const CONTACT_SHADOW_TEXTURE_SIZE = 64;

/**
 * Renders a soft, deterministic radial-gradient alpha texture: opaque black
 * at the center, fading to fully transparent at the edge. Pure function of
 * pixel index (no `Math.random()`), matching `environment-registry.ts`'s own
 * procedural-texture precedent, so the same decal renders byte-identical
 * pixels every time this module is evaluated.
 */
function renderContactShadowTexture(): THREE.DataTexture {
  const size = CONTACT_SHADOW_TEXTURE_SIZE;
  const center = (size - 1) / 2;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - center) / center;
      const dy = (y - center) / center;
      const distance = Math.sqrt(dx * dx + dy * dy);
      // Smoothstep falloff from the center (opaque) to the edge (transparent),
      // clamped so anything outside the unit circle is fully transparent.
      const t = Math.min(1, Math.max(0, distance));
      const alpha = 1 - t * t * (3 - 2 * t);
      const index = (y * size + x) * 4;
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

/** Module-level singleton: every contact-shadow mesh shares the same decal texture, exactly like `node-factory.ts`'s own pooled placeholder geometry/materials. */
let sharedContactShadowTexture: THREE.DataTexture | undefined;

function resolveSharedContactShadowTexture(): THREE.DataTexture {
  sharedContactShadowTexture ??= renderContactShadowTexture();
  return sharedContactShadowTexture;
}

/**
 * Builds a single ground-plane contact-shadow decal mesh: a flat, circular,
 * soft-edged dark disc positioned at `groundY`, facing up. A cheap,
 * real, cross-backend-consistent technique (no screen-space or depth-buffer
 * dependency at all, unlike full SSAO/GTAO) for grounding shadow-casting
 * content in a shot, per Phase 57's own "contact or soft ground shadows"
 * task - deliberately simpler than a true depth-aware contact-shadow pass,
 * since a flat decal already reads as "this object touches the ground" at
 * normal viewing angles, without needing either backend's own post-processing
 * pipeline at all.
 */
export function createContactShadowMesh(groundY: number, opacity: number, radius: number): THREE.Mesh {
  const geometry = new THREE.CircleGeometry(radius, 48);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: resolveSharedContactShadowTexture(),
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = groundY;
  mesh.renderOrder = -1;
  return mesh;
}
