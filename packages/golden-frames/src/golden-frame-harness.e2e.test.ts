import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ColorRGBA } from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  compareGoldenSceneAgainstReference,
  referencePngPath,
  updateGoldenSceneReference,
  writeGoldenFrameDiffArtifacts,
} from "./golden-frame-harness.js";
import type { GoldenScene } from "./scenes/golden-scene.js";
import { lightingScene } from "./scenes/index.js";

const RECOLORED_BASE_COLOR: ColorRGBA = [0, 1, 0, 1];

/** `lightingScene`, with its own sphere recolored bright green: an intentional, deterministic content change to prove a comparison catches drift. */
function buildRecoloredLightingScene(): GoldenScene {
  return {
    ...lightingScene,
    buildProject: () => {
      const project = lightingScene.buildProject();
      const composition = project.compositions[0];
      if (composition === undefined) {
        throw new Error("lightingScene always returns exactly one composition.");
      }
      const recoloredComposition = {
        ...composition,
        tracks: composition.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((clip) => ({
            ...clip,
            node:
              clip.node.kind === "group"
                ? {
                    ...clip.node,
                    children: clip.node.children.map((child) =>
                      child.id === "sphere-1" && child.kind === "mesh"
                        ? { ...child, material: { ...child.material, baseColor: RECOLORED_BASE_COLOR } }
                        : child,
                    ),
                  }
                : clip.node,
          })),
        })),
      };
      return { ...project, compositions: [recoloredComposition] };
    },
  };
}

/**
 * Real, non-mocked coverage of this harness's own compare/update flow
 * (Phase 71 tasks 4 and 6): every test here renders `lightingScene` for
 * real through `createNativeGpuHeadlessRenderer` (the fastest of this
 * package's two drivers), against a scratch `references/`-shaped directory
 * unique to each test, never this package's own checked-in `references/`.
 */
describe("golden-frame compare/update flow", () => {
  function withScratchReferencesDir<T>(run: (referencesDir: string) => Promise<T>): Promise<T> {
    const referencesDir = mkdtempSync(join(tmpdir(), "cadra-golden-frames-e2e-"));
    return run(referencesDir).finally(() => rmSync(referencesDir, { recursive: true, force: true }));
  }

  it("reports missing-reference when no reference exists yet", async () => {
    await withScratchReferencesDir(async (referencesDir) => {
      const result = await compareGoldenSceneAgainstReference(lightingScene, { referencesDir });

      expect(result.pass).toBe(false);
      expect(result.reason).toBe("missing-reference");
      expect(result.referencePixels).toBeUndefined();
      expect(result.renderedPixels.width).toBe(lightingScene.width);
    });
  });

  it("updateGoldenSceneReference writes a real PNG a later compare call matches with zero diff (task 6: identical renders produce zero diff)", async () => {
    await withScratchReferencesDir(async (referencesDir) => {
      const updateResult = await updateGoldenSceneReference(lightingScene, { referencesDir });
      expect(updateResult.wasNew).toBe(true);
      expect(updateResult.diffFromPrevious).toBeUndefined();

      const pngBytes = readFileSync(referencePngPath(lightingScene, referencesDir));
      expect(pngBytes.length).toBeGreaterThan(0);

      const compareResult = await compareGoldenSceneAgainstReference(lightingScene, { referencesDir });
      expect(compareResult.pass).toBe(true);
      expect(compareResult.reason).toBe("match");
      expect(compareResult.diff?.diffPixelCount).toBe(0);
      expect(compareResult.diff?.diffRatio).toBe(0);
    });
  });

  it("catches an intentional change: a differently-colored scene fails the same reference (task 6)", async () => {
    await withScratchReferencesDir(async (referencesDir) => {
      await updateGoldenSceneReference(lightingScene, { referencesDir });

      const result = await compareGoldenSceneAgainstReference(buildRecoloredLightingScene(), { referencesDir });

      expect(result.pass).toBe(false);
      expect(result.reason).toBe("diff-exceeds-tolerance");
      expect(result.diff).toBeDefined();
      expect(result.diff?.diffPixelCount).toBeGreaterThan(0);
    });
  });

  it("updateGoldenSceneReference reports a non-zero diffFromPrevious when overwriting a changed reference", async () => {
    await withScratchReferencesDir(async (referencesDir) => {
      await updateGoldenSceneReference(lightingScene, { referencesDir });

      const secondUpdate = await updateGoldenSceneReference(buildRecoloredLightingScene(), { referencesDir });

      expect(secondUpdate.wasNew).toBe(false);
      expect(secondUpdate.diffFromPrevious?.diffPixelCount).toBeGreaterThan(0);
    });
  });

  it("writeGoldenFrameDiffArtifacts writes real actual/expected/diff PNGs for a failing comparison", async () => {
    await withScratchReferencesDir(async (referencesDir) => {
      await updateGoldenSceneReference(lightingScene, { referencesDir });

      const result = await compareGoldenSceneAgainstReference(buildRecoloredLightingScene(), { referencesDir });
      const diffOutputDir = join(referencesDir, "diff-output");
      writeGoldenFrameDiffArtifacts(result, diffOutputDir);

      const actual = readFileSync(join(diffOutputDir, `${lightingScene.name}-actual.png`));
      const expected = readFileSync(join(diffOutputDir, `${lightingScene.name}-expected.png`));
      const diffPng = readFileSync(join(diffOutputDir, `${lightingScene.name}-diff.png`));
      expect(actual.length).toBeGreaterThan(0);
      expect(expected.length).toBeGreaterThan(0);
      expect(diffPng.length).toBeGreaterThan(0);
    });
  });
});
