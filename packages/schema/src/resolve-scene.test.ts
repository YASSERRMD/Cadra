import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveSceneAtFrame } from "@cadra/core";
import { describe, expect, it } from "vitest";

import { parseScene } from "./parse.js";

/**
 * End-to-end proof that a real, Phase 4 JSON-authored scene document, once
 * parsed, resolves correctly through Phase 8's `resolveSceneAtFrame`: not a
 * synthetic fixture built directly from `@cadra/core` primitives, but the
 * exact same `.scene.json` files `parse.test.ts` and `examples.test.ts`
 * already validate.
 */

const EXAMPLE_NAMES = ["title-card", "moving-shape", "camera-pan"] as const;

function loadExample(name: (typeof EXAMPLE_NAMES)[number]): unknown {
  const path = fileURLToPath(new URL(`../examples/${name}.scene.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("resolveSceneAtFrame resolves parsed Phase 4 example documents", () => {
  it.each(EXAMPLE_NAMES)(
    "resolves the %s example at frame 0, a middle frame, and the last frame",
    (name) => {
      const result = parseScene(loadExample(name));
      if (!result.success) {
        throw new Error(
          `expected ${name} to parse successfully: ${JSON.stringify(result.diagnostics)}`,
        );
      }

      const { project } = result.document;
      const composition = project.compositions[0];
      if (composition === undefined) {
        throw new Error(`expected ${name} to have at least one composition`);
      }

      const lastFrame = composition.durationInFrames - 1;
      const middleFrame = Math.floor(composition.durationInFrames / 2);

      for (const frame of [0, middleFrame, lastFrame]) {
        const state = resolveSceneAtFrame(project, composition.id, frame);

        expect(state.compositionId).toBe(composition.id);
        expect(state.frame).toBe(frame);
        expect(state.width).toBe(composition.width);
        expect(state.height).toBe(composition.height);
        expect(state.layers.length).toBeGreaterThan(0);

        // Every layer's zIndex matches its array position, and every layer
        // traces back to a track/clip that actually exists in this
        // composition: a real end-to-end sanity check, not just "some object
        // came back."
        state.layers.forEach((layer, index) => {
          expect(layer.zIndex).toBe(index);
          const track = composition.tracks.find((candidate) => candidate.id === layer.trackId);
          expect(track).toBeDefined();
          expect(track?.clips.some((clip) => clip.id === layer.clipId)).toBe(true);
        });
      }
    },
  );

  it("resolves the moving-shape example to only the currently-active clip's shape at each of its three clip windows", () => {
    const result = parseScene(loadExample("moving-shape"));
    if (!result.success) {
      throw new Error(
        `expected moving-shape to parse successfully: ${JSON.stringify(result.diagnostics)}`,
      );
    }

    const { project } = result.document;
    const composition = project.compositions[0];
    if (composition === undefined) {
      throw new Error("expected moving-shape to have at least one composition");
    }

    // The moving-shape example places three 30-frame clips back to back
    // (clip-shape-left, clip-shape-center, clip-shape-right) on one track.
    const atFrame0 = resolveSceneAtFrame(project, composition.id, 0);
    const atFrame30 = resolveSceneAtFrame(project, composition.id, 30);
    const atFrame89 = resolveSceneAtFrame(project, composition.id, 89);

    expect(atFrame0.layers).toHaveLength(1);
    expect(atFrame0.layers[0]?.clipId).toBe("clip-shape-left");

    expect(atFrame30.layers).toHaveLength(1);
    expect(atFrame30.layers[0]?.clipId).toBe("clip-shape-center");

    expect(atFrame89.layers).toHaveLength(1);
    expect(atFrame89.layers[0]?.clipId).toBe("clip-shape-right");
  });
});
