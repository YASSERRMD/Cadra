import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hashAssetBytes, type TextStaggerConfig } from "@cadra/core";
import { parseFontWithFontkit, prepareTextRenderData } from "@cadra/text";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { applyTextStagger } from "./apply-text-stagger.js";
import { buildTextGroup } from "./build-text-group.js";

function loadRobotoFlex(): Uint8Array {
  const path = fileURLToPath(
    new URL("../../../text/test-fixtures/fonts/RobotoFlex-Variable.ttf", import.meta.url),
  );
  return new Uint8Array(readFileSync(path));
}

const ROBOTO_FLEX_BYTES = loadRobotoFlex();
const ROBOTO_FLEX = parseFontWithFontkit(ROBOTO_FLEX_BYTES);
const ROBOTO_FLEX_SOURCE = { bytes: ROBOTO_FLEX_BYTES, contentHash: hashAssetBytes(ROBOTO_FLEX_BYTES) };

const TYPEWRITER: TextStaggerConfig = {
  preset: "typewriter",
  grouping: "character",
  startFrame: 0,
  delayFrames: 10,
  durationFrames: 1,
};

describe("applyTextStagger: typewriter (opacity only)", () => {
  it("reveals only the earlier glyph's material, provably per glyph rather than uniformly", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "ab");
    const resources = buildTextGroup(data, {
      color: [1, 1, 1, 1],
      extrudeDepth: 0.2,
      font: ROBOTO_FLEX_SOURCE,
      perGlyphMaterial: true,
    });

    // Frame 1: rank 0 (the first glyph, own window [0,1]) has just finished
    // revealing; rank 1 (own window [10,11]) has not started.
    applyTextStagger(resources.group, data.glyphs, TYPEWRITER, 1);

    const [firstGlyph, secondGlyph] = data.glyphs;
    const firstMesh = resources.group.getObjectByName(
      `glyph-${firstGlyph?.cluster}-${firstGlyph?.glyphId}`,
    ) as THREE.Mesh;
    const secondMesh = resources.group.getObjectByName(
      `glyph-${secondGlyph?.cluster}-${secondGlyph?.glyphId}`,
    ) as THREE.Mesh;

    expect((firstMesh.material as THREE.MeshStandardMaterial).opacity).toBe(1);
    expect((secondMesh.material as THREE.MeshStandardMaterial).opacity).toBe(0);
  });

  it("does not touch position when the preset never sets offsetY", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const positionBefore = mesh.position.clone();

    applyTextStagger(resources.group, data.glyphs, TYPEWRITER, 1);

    expect(mesh.position.equals(positionBefore)).toBe(true);
  });
});

const FADE_IN_UP: TextStaggerConfig = {
  preset: "fadeInUp",
  grouping: "word",
  startFrame: 0,
  delayFrames: 0,
  durationFrames: 10,
  distance: 1,
};

describe("applyTextStagger: fadeInUp (opacity plus position offset)", () => {
  it("offsets a glyph mesh's y position below its own basePosition before reveal, decaying to it as the reveal completes", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const basePosition = mesh.userData["basePosition"] as THREE.Vector3;

    applyTextStagger(resources.group, data.glyphs, FADE_IN_UP, 0);
    expect(mesh.position.y).toBeCloseTo(basePosition.y - 1, 5);

    applyTextStagger(resources.group, data.glyphs, FADE_IN_UP, 10);
    expect(mesh.position.y).toBeCloseTo(basePosition.y, 5);
  });

  it("leaves x and z untouched, only offsetting y", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const basePosition = mesh.userData["basePosition"] as THREE.Vector3;

    applyTextStagger(resources.group, data.glyphs, FADE_IN_UP, 3);

    expect(mesh.position.x).toBeCloseTo(basePosition.x, 5);
    expect(mesh.position.z).toBeCloseTo(basePosition.z, 5);
  });
});

describe("applyTextStagger: robustness", () => {
  it("silently skips a glyph whose mesh cannot be found, rather than throwing", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const bogusGlyph = { ...(data.glyphs[0] as (typeof data.glyphs)[number]), cluster: 999, glyphId: 999 };

    expect(() =>
      applyTextStagger(resources.group, [...data.glyphs, bogusGlyph], TYPEWRITER, 0),
    ).not.toThrow();
  });
});
