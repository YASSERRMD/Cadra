import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { hashAssetBytes, type TextPhysicsConfig, type TextStaggerConfig } from "@cadra/core";
import { parseFontWithFontkit, prepareTextRenderData } from "@cadra/text";
import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { applyTextEffects } from "./apply-text-effects.js";
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

describe("applyTextEffects: stagger only (Phase 50 behavior preserved)", () => {
  it("reveals only the earlier glyph's material, provably per glyph rather than uniformly", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "ab");
    const resources = buildTextGroup(data, {
      color: [1, 1, 1, 1],
      extrudeDepth: 0.2,
      font: ROBOTO_FLEX_SOURCE,
      perGlyphMaterial: true,
    });

    applyTextEffects(resources.group, data.glyphs, { stagger: TYPEWRITER }, 1);

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

  it("does not offset position when the preset never sets offsetY", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const positionBefore = mesh.position.clone();

    applyTextEffects(resources.group, data.glyphs, { stagger: TYPEWRITER }, 1);

    expect(mesh.position.equals(positionBefore)).toBe(true);
  });

  it("leaves rotation at 0 and scale at 1 when no physics config is given", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;

    applyTextEffects(resources.group, data.glyphs, { stagger: TYPEWRITER }, 1);

    expect(mesh.rotation.z).toBe(0);
    expect(mesh.scale.x).toBe(1);
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

describe("applyTextEffects: fadeInUp stagger (opacity plus position offset)", () => {
  it("offsets a glyph mesh's y position below its own basePosition before reveal, decaying to it as the reveal completes", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const basePosition = mesh.userData["basePosition"] as THREE.Vector3;

    applyTextEffects(resources.group, data.glyphs, { stagger: FADE_IN_UP }, 0);
    expect(mesh.position.y).toBeCloseTo(basePosition.y - 1, 5);

    applyTextEffects(resources.group, data.glyphs, { stagger: FADE_IN_UP }, 10);
    expect(mesh.position.y).toBeCloseTo(basePosition.y, 5);
  });
});

const JITTER: TextPhysicsConfig = {
  effect: "jitter",
  grouping: "character",
  seed: 3,
  positionAmplitude: 0.5,
  rotationAmplitude: 0.3,
  periodFrames: 10,
};

describe("applyTextEffects: physics only", () => {
  it("offsets a glyph mesh's x/y position by the resolved jitter, on top of its own basePosition", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const basePosition = mesh.userData["basePosition"] as THREE.Vector3;

    applyTextEffects(resources.group, data.glyphs, { physics: JITTER }, 5);

    expect(mesh.position.x).not.toBeCloseTo(basePosition.x, 5);
    expect(Math.abs(mesh.position.x - basePosition.x)).toBeLessThanOrEqual(0.5);
    expect(mesh.rotation.z).not.toBe(0);
  });

  it("does not call setOpacity when physics does not resolve an opacity", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, {
      color: [1, 1, 1, 1],
      extrudeDepth: 0.2,
      font: ROBOTO_FLEX_SOURCE,
      perGlyphMaterial: true,
    });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    const opacityBefore = material.opacity;

    applyTextEffects(resources.group, data.glyphs, { physics: JITTER }, 5);

    expect(material.opacity).toBe(opacityBefore);
  });

  it("sets scale from a spring effect's own resolved progress", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;

    const spring: TextPhysicsConfig = { effect: "spring", grouping: "character", fps: 30 };
    applyTextEffects(resources.group, data.glyphs, { physics: spring }, 0);
    expect(mesh.scale.x).toBe(0);

    applyTextEffects(resources.group, data.glyphs, { physics: spring }, 90);
    expect(mesh.scale.x).toBeCloseTo(1, 1);
  });
});

describe("applyTextEffects: stagger and physics compose", () => {
  it("adds the physics offsetY on top of the stagger offsetY, rather than one replacing the other", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const basePosition = mesh.userData["basePosition"] as THREE.Vector3;

    // At frame 5: FADE_IN_UP (distance 1, duration 10, linear) is at
    // progress 0.5, so its own offsetY is 1*(0.5-1) = -0.5. A wave physics
    // effect (amplitude 0.5, periodFrames 20) peaks at frame 5
    // (sin(2*pi*5/20) = sin(pi/2) = 1), so its own offsetY is +0.5. Summed,
    // the two exactly cancel back to the glyph's own natural position -
    // only possible if both are genuinely added together, not one
    // replacing the other.
    const wave: TextPhysicsConfig = {
      effect: "wave",
      grouping: "character",
      positionAmplitude: 0.5,
      periodFrames: 20,
    };
    applyTextEffects(resources.group, data.glyphs, { stagger: FADE_IN_UP, physics: wave }, 5);

    expect(mesh.position.y).toBeCloseTo(basePosition.y, 5);
  });

  it("multiplies opacity when both stagger and a spring physics effect resolve one", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, {
      color: [1, 1, 1, 1],
      extrudeDepth: 0.2,
      font: ROBOTO_FLEX_SOURCE,
      perGlyphMaterial: true,
    });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;

    // Stagger not yet revealed (opacity 0) at frame 0; spring also at its
    // own starting opacity (0) at frame 0 - combined must still be 0, not
    // accidentally 1 from only one side being considered.
    applyTextEffects(
      resources.group,
      data.glyphs,
      { stagger: FADE_IN_UP, physics: { effect: "spring", grouping: "character", fps: 30 } },
      0,
    );
    expect(material.opacity).toBe(0);
  });
});

describe("applyTextEffects: robustness", () => {
  it("silently skips a glyph whose mesh cannot be found, rather than throwing", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const bogusGlyph = { ...(data.glyphs[0] as (typeof data.glyphs)[number]), cluster: 999, glyphId: 999 };

    expect(() =>
      applyTextEffects(resources.group, [...data.glyphs, bogusGlyph], { stagger: TYPEWRITER }, 0),
    ).not.toThrow();
  });

  it("is a no-op when neither stagger nor physics is given", async () => {
    const data = await prepareTextRenderData(ROBOTO_FLEX, "a");
    const resources = buildTextGroup(data, { color: [1, 1, 1, 1], perGlyphMaterial: true });
    const glyph = data.glyphs[0];
    const mesh = resources.group.getObjectByName(`glyph-${glyph?.cluster}-${glyph?.glyphId}`) as THREE.Mesh;
    const positionBefore = mesh.position.clone();

    expect(() => applyTextEffects(resources.group, data.glyphs, {}, 5)).not.toThrow();
    expect(mesh.position.equals(positionBefore)).toBe(true);
  });
});
