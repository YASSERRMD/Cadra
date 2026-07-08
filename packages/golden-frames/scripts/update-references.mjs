#!/usr/bin/env node
/**
 * Phase 71's one-command "accept the current render as correct" flow: for
 * every curated `GoldenScene`, renders it fresh and overwrites its own
 * checked-in `references/<name>.png`, reporting a compact summary of
 * what changed for review before anything is committed.
 *
 * Deliberately a standalone script (imported from this package's own
 * compiled `dist/`, not part of `build`/`typecheck`/`lint`/`test`),
 * mirroring `@cadra/headless`'s own `scripts/benchmark-native-vs-browser.mjs`:
 * this is a human-triggered, mutating action - never run automatically
 * (in particular, never from CI's own non-blocking report job) - so it
 * stays out of every automated script's critical path.
 *
 * Spawns `update-one-reference.mjs` as a fresh child process per scene,
 * one at a time, rather than rendering every scene directly in this
 * process: see that script's own doc for why (a real, reproducible native
 * crash in the experimental `webgpu` package binding after a handful of
 * construct/render/dispose cycles in one process).
 *
 * Usage (from this package's own directory, after `pnpm build`):
 *   node scripts/update-references.mjs
 *
 * Review the resulting `git diff --stat references/` (or open the changed
 * PNGs directly) before committing: this script overwrites every
 * reference unconditionally, with no confirmation prompt of its own -
 * reviewing the diff *is* the confirmation step.
 */

import { execFileSync } from "node:child_process";

import { GOLDEN_SCENES } from "../dist/index.js";

function formatResult(result) {
  if (result.wasNew) {
    return "new reference";
  }
  if (result.diffPixelCount === null) {
    return "reference size changed";
  }
  if (result.diffPixelCount === 0) {
    return "unchanged";
  }
  const percent = (result.diffRatio * 100).toFixed(3);
  return `changed (${result.diffPixelCount} px, ${percent}%)`;
}

const scriptPath = new URL("./update-one-reference.mjs", import.meta.url).pathname;

console.log(`Updating ${GOLDEN_SCENES.length} golden-frame reference(s)`);

let changedCount = 0;
let newCount = 0;
let failedCount = 0;

for (const scene of GOLDEN_SCENES) {
  process.stdout.write(`  ${scene.name} ... `);
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, scene.name], { encoding: "utf8" });
    const result = JSON.parse(stdout.trim().split("\n").pop());
    console.log(formatResult(result));
    if (result.wasNew) {
      newCount += 1;
    } else if ((result.diffPixelCount ?? 0) > 0) {
      changedCount += 1;
    }
  } catch (error) {
    failedCount += 1;
    console.log("FAILED");
    console.error(error.stderr?.toString() ?? error.message);
  }
}

console.log("");
console.log(
  `Done: ${newCount} new, ${changedCount} changed, ` +
    `${GOLDEN_SCENES.length - newCount - changedCount - failedCount} unchanged, ${failedCount} failed.`,
);
if (newCount > 0 || changedCount > 0) {
  console.log("Review the updated PNGs (e.g. `git diff --stat references/`) before committing.");
}
if (failedCount > 0) {
  process.exitCode = 1;
}
