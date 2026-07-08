#!/usr/bin/env node
/**
 * Renders and writes exactly one `GoldenScene`'s own reference PNG, then
 * prints its `GoldenFrameUpdateResult` as one line of JSON to stdout.
 *
 * Exists as its own separate process (spawned once per scene by
 * `update-references.mjs`, never imported directly) because
 * `createNativeGpuHeadlessRenderer`'s underlying native `webgpu` package
 * binding was found, while building this script, to reliably crash the
 * whole Node process (a native segfault, not a catchable JS error) after
 * a handful of construct/render/dispose cycles within one process -
 * verified directly: running every curated scene's own update back to
 * back in a single process crashed at a different scene each attempt,
 * consistent with an accumulating native resource issue in that
 * experimental binding rather than any one scene's own content. Isolating
 * each scene to a fresh OS process sidesteps this entirely, at the cost of
 * one Node startup per scene (a few hundred milliseconds, negligible next
 * to a real GPU render).
 *
 * Usage: node scripts/update-one-reference.mjs <scene-name>
 */

import { GOLDEN_SCENES, updateGoldenSceneReference } from "../dist/index.js";

const sceneName = process.argv[2];
if (sceneName === undefined) {
  console.error("Usage: node scripts/update-one-reference.mjs <scene-name>");
  process.exit(1);
}

const scene = GOLDEN_SCENES.find((candidate) => candidate.name === sceneName);
if (scene === undefined) {
  console.error(
    `update-one-reference: no golden scene named "${sceneName}". Known scenes: ${GOLDEN_SCENES.map((candidate) => candidate.name).join(", ")}`,
  );
  process.exit(1);
}

const referencesDir = new URL("../references/", import.meta.url).pathname;

updateGoldenSceneReference(scene, { referencesDir })
  .then((result) => {
    console.log(
      JSON.stringify({
        name: scene.name,
        wasNew: result.wasNew,
        diffPixelCount: result.diffFromPrevious?.diffPixelCount ?? null,
        diffRatio: result.diffFromPrevious?.diffRatio ?? null,
      }),
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
