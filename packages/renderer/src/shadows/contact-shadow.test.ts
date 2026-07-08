import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createContactShadowMesh } from "./contact-shadow.js";

describe("createContactShadowMesh", () => {
  it("builds a real, flat, upward-facing circular mesh positioned at groundY", () => {
    const mesh = createContactShadowMesh(1.5, 0.5, 2);

    expect(mesh).toBeInstanceOf(THREE.Mesh);
    expect(mesh.geometry).toBeInstanceOf(THREE.CircleGeometry);
    expect(mesh.position.y).toBe(1.5);
  });

  it("applies the requested opacity to a transparent, non-depth-writing material", () => {
    const mesh = createContactShadowMesh(0, 0.7, 2);
    const material = mesh.material as THREE.MeshBasicMaterial;

    expect(material.opacity).toBe(0.7);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });

  it("sizes the circle geometry to the requested radius", () => {
    const mesh = createContactShadowMesh(0, 0.5, 3);
    const geometry = mesh.geometry as THREE.CircleGeometry;

    expect(geometry.parameters.radius).toBe(3);
  });

  it("uses a real, non-uniform decal texture (a soft gradient, not a flat placeholder)", () => {
    const mesh = createContactShadowMesh(0, 0.5, 2);
    const material = mesh.material as THREE.MeshBasicMaterial;
    const texture = material.map as THREE.DataTexture;
    const data = texture.image.data as Uint8Array;
    const size = texture.image.width;
    const centerAlpha = data[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3] as number;
    const edgeAlpha = data[3] as number;

    expect(centerAlpha).toBeGreaterThan(edgeAlpha);
    expect(edgeAlpha).toBe(0);
  });

  it("is deterministic: two separately built meshes share byte-identical decal texture pixels", () => {
    const first = createContactShadowMesh(0, 0.5, 2);
    const second = createContactShadowMesh(0, 0.5, 2);
    const firstData = ((first.material as THREE.MeshBasicMaterial).map as THREE.DataTexture).image.data as Uint8Array;
    const secondData = ((second.material as THREE.MeshBasicMaterial).map as THREE.DataTexture).image
      .data as Uint8Array;

    expect(Array.from(secondData)).toEqual(Array.from(firstData));
  });

  it("pools the same shared decal texture instance across meshes (no per-mesh regeneration)", () => {
    const first = createContactShadowMesh(0, 0.5, 2);
    const second = createContactShadowMesh(1, 0.3, 4);

    expect((second.material as THREE.MeshBasicMaterial).map).toBe(
      (first.material as THREE.MeshBasicMaterial).map,
    );
  });
});
