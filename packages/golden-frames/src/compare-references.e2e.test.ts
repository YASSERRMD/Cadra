import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareGoldenSceneAgainstReference, DEFAULT_REFERENCES_DIR, writeGoldenFrameDiffArtifacts } from "./golden-frame-harness.js";
import { GOLDEN_SCENES } from "./scenes/index.js";

/**
 * This package's own CI-facing regression check (Phase 71 task 3): renders
 * every curated `GoldenScene` for real and compares it against this
 * package's checked-in `references/<name>.png`, via a tight perceptual
 * tolerance (see `comparePixelBuffers`'s own doc for why this is not exact
 * byte equality).
 *
 * A failure here means either a real, unintended visual regression, or a
 * deliberate change whose reference has not been updated yet - run
 * `pnpm --filter @cadra/golden-frames run update-references`, review the
 * resulting PNG diffs, and commit them (see that script's own doc).
 *
 * `.github/workflows/ci.yml` runs this suite as its own `continue-on-error`
 * job specifically so a golden-frame diff reports clearly on a PR without
 * blocking merges on it (Phase 71's own explicit, deliberately non-blocking
 * design - see this repo's own CI workflow for the job itself), uploading
 * `diff-output/` (written below for every failing scene) as a build
 * artifact for a reviewer to inspect.
 */
describe("golden-frame regression: every curated scene against its checked-in reference", () => {
  const diffOutputDir = join(process.cwd(), "diff-output");

  it.each(GOLDEN_SCENES.map((scene) => [scene.name, scene] as const))(
    "%s matches its checked-in reference within tolerance",
    async (_name, scene) => {
      const result = await compareGoldenSceneAgainstReference(scene, { referencesDir: DEFAULT_REFERENCES_DIR });

      if (!result.pass) {
        writeGoldenFrameDiffArtifacts(result, diffOutputDir);
      }

      const detail =
        result.diff === undefined
          ? result.reason
          : `${result.reason}: ${result.diff.diffPixelCount}/${result.diff.totalPixelCount} px (${(result.diff.diffRatio * 100).toFixed(3)}%)`;
      expect(result.pass, `${scene.name}: ${detail}`).toBe(true);
    },
    // A real browser launch for the path-traced scene comfortably exceeds
    // Vitest's 5s default under concurrent load; see
    // render-browser-scene.e2e.test.ts's own identical timeout.
    30_000,
  );
});
