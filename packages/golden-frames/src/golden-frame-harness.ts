import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { PixelBuffer } from "@cadra/renderer";

import { comparePixelBuffers, DEFAULT_DIFF_RATIO_TOLERANCE, isWithinTolerance, type PerceptualDiffResult } from "./perceptual-diff.js";
import { decodePngToPixelBuffer, encodePixelBufferToPng } from "./png-codec.js";
import { renderBrowserGoldenScene } from "./render-browser-scene.js";
import { renderRasterGoldenScene } from "./render-raster-scene.js";
import type { GoldenScene } from "./scenes/golden-scene.js";

/** This package's own checked-in `references/` directory, resolved relative to this module's own compiled location (mirroring `render-raster-scene.ts`'s identical `FONT_FIXTURES_DIR` rationale), i.e. the default every caller in this package uses unless it has a specific reason not to (a test using a scratch directory, for instance). */
export const DEFAULT_REFERENCES_DIR: string = new URL("../references/", import.meta.url).pathname;

/**
 * Renders `scene` through whichever driver it declares (`scene.driver`);
 * the one place this harness dispatches between
 * `createNativeGpuHeadlessRenderer` (`render-raster-scene.ts`) and the
 * real-browser Playwright bridge (`render-browser-scene.ts`), so every
 * other module in this package (the compare/update flow, the CLI script)
 * can stay agnostic to which one a given scene actually needs.
 */
export async function renderGoldenScene(scene: GoldenScene): Promise<PixelBuffer> {
  return scene.driver === "browser" ? renderBrowserGoldenScene(scene) : renderRasterGoldenScene(scene);
}

/** Absolute path to `scene`'s own checked-in reference PNG under `referencesDir`. */
export function referencePngPath(scene: GoldenScene, referencesDir: string): string {
  return join(referencesDir, `${scene.name}.png`);
}

/** Why a `compareGoldenSceneAgainstReference` call did or did not pass. */
export type GoldenFrameCompareReason =
  | "match"
  | "missing-reference"
  | "size-mismatch"
  | "diff-exceeds-tolerance";

/** The result of comparing one freshly-rendered `GoldenScene` against its checked-in reference. */
export interface GoldenFrameCompareResult {
  scene: GoldenScene;
  pass: boolean;
  reason: GoldenFrameCompareReason;
  /** The scene's own freshly rendered pixels, always present. */
  renderedPixels: PixelBuffer;
  /** The checked-in reference's own pixels, absent only for `reason: "missing-reference"`. */
  referencePixels?: PixelBuffer;
  /** The perceptual diff against the reference, present only when both buffers were the same size (`reason` is `"match"` or `"diff-exceeds-tolerance"`). */
  diff?: PerceptualDiffResult;
}

/** Options shared by `compareGoldenSceneAgainstReference` and `updateGoldenSceneReference`. */
export interface GoldenFrameReferenceOptions {
  /** Directory holding every scene's own checked-in `<name>.png` reference (this package's own `references/` by default; see `referencePngPath`). */
  referencesDir: string;
  /** `pixelmatch`-driven diff ratio a comparison tolerates before failing. Defaults to `DEFAULT_DIFF_RATIO_TOLERANCE`. */
  tolerance?: number;
}

/**
 * Renders `scene` fresh and compares it against its checked-in reference
 * PNG (`referencePngPath`), via `comparePixelBuffers`'s tight-tolerance
 * perceptual diff (see that function's own doc for why this is not exact
 * byte equality). A missing reference or a size mismatch both fail
 * (`reason: "missing-reference"`/`"size-mismatch"`) without attempting a
 * pixel diff at all, since neither is a meaningful comparison.
 */
export async function compareGoldenSceneAgainstReference(
  scene: GoldenScene,
  options: GoldenFrameReferenceOptions,
): Promise<GoldenFrameCompareResult> {
  const renderedPixels = await renderGoldenScene(scene);
  const path = referencePngPath(scene, options.referencesDir);

  if (!existsSync(path)) {
    return { scene, pass: false, reason: "missing-reference", renderedPixels };
  }

  const referencePixels = decodePngToPixelBuffer(readFileSync(path));
  if (referencePixels.width !== renderedPixels.width || referencePixels.height !== renderedPixels.height) {
    return { scene, pass: false, reason: "size-mismatch", renderedPixels, referencePixels };
  }

  const diff = comparePixelBuffers(renderedPixels, referencePixels);
  const tolerance = options.tolerance ?? DEFAULT_DIFF_RATIO_TOLERANCE;
  const pass = isWithinTolerance(diff, tolerance);

  return {
    scene,
    pass,
    reason: pass ? "match" : "diff-exceeds-tolerance",
    renderedPixels,
    referencePixels,
    diff,
  };
}

/** Writes `result`'s rendered/reference/diff images to `outputDir` as `<name>-actual.png`/`<name>-expected.png`/`<name>-diff.png`, for a reviewer (or a CI artifact upload) to inspect. Only ever writes what `result` actually has: a `"missing-reference"` result has no `<name>-expected.png`/`<name>-diff.png`. */
export function writeGoldenFrameDiffArtifacts(result: GoldenFrameCompareResult, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  const stem = join(outputDir, result.scene.name);

  writeFileSync(`${stem}-actual.png`, encodePixelBufferToPng(result.renderedPixels));
  if (result.referencePixels !== undefined) {
    writeFileSync(`${stem}-expected.png`, encodePixelBufferToPng(result.referencePixels));
  }
  if (result.diff !== undefined) {
    writeFileSync(`${stem}-diff.png`, encodePixelBufferToPng(result.diff.diffImage));
  }
}

/** The result of (re-)writing one `GoldenScene`'s own reference PNG. */
export interface GoldenFrameUpdateResult {
  scene: GoldenScene;
  /** `true` if `referencesDir` had no reference for this scene at all before this call. */
  wasNew: boolean;
  /** The diff between the old and newly-rendered reference; absent when `wasNew`, or when the old reference was a different size (nothing meaningful to diff). */
  diffFromPrevious?: PerceptualDiffResult;
}

/**
 * Renders `scene` fresh and overwrites its checked-in reference PNG,
 * unconditionally: this is the one-command "accept the current render as
 * correct" flow (see this package's own `scripts/update-references.mjs`),
 * meant to be run deliberately by a human after reviewing what changed
 * (typically via `writeGoldenFrameDiffArtifacts`'s own output, or the
 * checked-in PNG's own diff in the resulting commit/PR), never
 * automatically.
 */
export async function updateGoldenSceneReference(
  scene: GoldenScene,
  options: GoldenFrameReferenceOptions,
): Promise<GoldenFrameUpdateResult> {
  const renderedPixels = await renderGoldenScene(scene);
  const path = referencePngPath(scene, options.referencesDir);
  const wasNew = !existsSync(path);

  let diffFromPrevious: PerceptualDiffResult | undefined;
  if (!wasNew) {
    const previousPixels = decodePngToPixelBuffer(readFileSync(path));
    if (previousPixels.width === renderedPixels.width && previousPixels.height === renderedPixels.height) {
      diffFromPrevious = comparePixelBuffers(renderedPixels, previousPixels);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePixelBufferToPng(renderedPixels));

  return { scene, wasNew, diffFromPrevious };
}
