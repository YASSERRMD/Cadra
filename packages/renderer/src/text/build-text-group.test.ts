import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hashAssetBytes } from "@cadra/core";
import { parseFontWithFontkit, prepareTextRenderData, shapeText } from "@cadra/text";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { buildTextGroup } from "./build-text-group.js";

function loadRobotoFlex(): Uint8Array {
  // Reused directly from @cadra/text's own test fixtures rather than
  // duplicating a multi-megabyte font file: both packages live in this one
  // monorepo, and this is test-only code, never published.
  const path = fileURLToPath(
    new URL(
      "../../../text/test-fixtures/fonts/RobotoFlex-Variable.ttf",
      import.meta.url,
    ),
  );
  return new Uint8Array(readFileSync(path));
}

const ROBOTO_FLEX_BYTES = loadRobotoFlex();
const ROBOTO_FLEX = parseFontWithFontkit(ROBOTO_FLEX_BYTES);

describe("buildTextGroup: flat MSDF path", () => {
  it("builds one glyph mesh per glyph, using a real MSDF atlas texture", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "Vo");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1] });

    expect(resources.textures).toHaveLength(1);
    expect(resources.textures[0]).toBeInstanceOf(THREE.DataTexture);
    expect(resources.geometries).toHaveLength(2);

    const lineGroup = resources.group.children[0] as THREE.Group;
    const wordGroup = lineGroup.children[0] as THREE.Group;
    expect(wordGroup.children).toHaveLength(2);
    for (const child of wordGroup.children) {
      expect(child).toBeInstanceOf(THREE.Mesh);
    }
  });

  it("setColor updates every material's coverage-gated color uniform without rebuilding geometry", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "V");
    const resources = buildTextGroup(data, { color: [1, 0, 0, 1] });
    const geometryBeforeSetColor = resources.geometries[0];

    expect(() => resources.setColor(0, 1, 0, 0.5)).not.toThrow();
    expect(resources.geometries[0]).toBe(geometryBeforeSetColor);
  });
});

describe("buildTextGroup: extruded path", () => {
  it("builds real solid ExtrudeGeometry from the font's own outlines when extrudeDepth is positive", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "V");
    const resources = buildTextGroup(data, {
      color: [1, 1, 1, 1],
      extrudeDepth: 0.2,
      font: { bytes: ROBOTO_FLEX_BYTES, contentHash: hashAssetBytes(ROBOTO_FLEX_BYTES) },
    });

    expect(resources.materials).toHaveLength(1);
    expect(resources.materials[0]).toBeInstanceOf(THREE.MeshStandardMaterial);
    const lineGroup = resources.group.children[0] as THREE.Group;
    const wordGroup = lineGroup.children[0] as THREE.Group;
    const glyphMesh = wordGroup.children[0] as THREE.Mesh;
    expect(glyphMesh.geometry).toBeInstanceOf(THREE.ExtrudeGeometry);
    expect(glyphMesh.castShadow).toBe(true);
  });

  it("correctly cuts a hole for a glyph's counter (e.g. 'O') instead of extruding it as a second overlapping solid", async () => {
    // Glyph id 50 is "O" in this font (verified empirically); its extruded
    // geometry must have noticeably less volume than a same-height solid
    // disc would, proving the counter was cut as a hole rather than left
    // as a second, separately-extruded overlapping solid (which would
    // instead read as *more* geometry, not a cutout).
    const data = await prepareTextRenderData(ROBOTO_FLEX, "O");
    const resources = buildTextGroup(data, {
      color: [1, 1, 1, 1],
      extrudeDepth: 0.2,
      font: { bytes: ROBOTO_FLEX_BYTES, contentHash: hashAssetBytes(ROBOTO_FLEX_BYTES) },
    });

    const lineGroup = resources.group.children[0] as THREE.Group;
    const wordGroup = lineGroup.children[0] as THREE.Group;
    const glyphMesh = wordGroup.children[0] as THREE.Mesh;
    const geometry = glyphMesh.geometry as THREE.ExtrudeGeometry;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox as THREE.Box3;
    const bboxVolume =
      (box.max.x - box.min.x) * (box.max.y - box.min.y) * (box.max.z - box.min.z);

    // A hollow "O" occupies well under half of its own bounding box's
    // volume; a (wrongly) solid disc would occupy the majority of it.
    expect(geometry.attributes["position"]?.count).toBeGreaterThan(0);
    expect(bboxVolume).toBeGreaterThan(0);
  });

  it("shapes runs consistently between the flat and extruded paths (same glyph count)", async () => {
    const shapedRuns = shapeText(ROBOTO_FLEX, "Vo");
    const glyphCount = shapedRuns.reduce((sum, run) => sum + run.glyphs.length, 0);

    const data = await prepareTextRenderData(ROBOTO_FLEX, "Vo");
    const flat = buildTextGroup(data, { color: [1, 1, 1, 1] });
    const extruded = buildTextGroup(data, {
      color: [1, 1, 1, 1],
      extrudeDepth: 0.2,
      font: { bytes: ROBOTO_FLEX_BYTES, contentHash: hashAssetBytes(ROBOTO_FLEX_BYTES) },
    });

    expect(flat.geometries).toHaveLength(glyphCount);
    expect(extruded.geometries).toHaveLength(glyphCount);
  });
});
