import type { RenderQualityTier } from "@cadra/core";

/**
 * The highest sample count actually used at the `"preview"` quality tier,
 * regardless of what an author authored: accumulation cost scales linearly
 * with sample count (each sample is a full extra scene render), so previews
 * cap it low for interactivity while `"final"` renders use the full
 * authored value. Mirrors `resolveAmbientOcclusion`'s own
 * cheaper-at-preview pattern in `three-renderer.ts`.
 */
const PREVIEW_SAMPLE_COUNT_CAP = 4;

/**
 * Resolves `CompositionPostProcessing.sampleCount` for `tier`: the full
 * authored value at `"final"`, capped at `PREVIEW_SAMPLE_COUNT_CAP` at
 * `"preview"`. Pure and deterministic - the same `(sampleCount, tier)` pair
 * always resolves to the same result.
 */
export function resolveSampleCountForTier(sampleCount: number, tier: RenderQualityTier): number {
  return tier === "preview" ? Math.min(sampleCount, PREVIEW_SAMPLE_COUNT_CAP) : sampleCount;
}

/**
 * Converts a literal sample count into the log2-scale `sampleLevel`
 * `SSAARenderPass`/`SSAAPassNode` (see `post-processing-pipeline.ts`'s own
 * `buildWebGl2Pipeline`/`buildWebGpuPipeline`) actually take: both index a
 * fixed jitter-vector table by `2^sampleLevel` samples, `sampleLevel` `0` to
 * `5` (`1` to `32` samples), verified directly against this project's
 * installed `three@0.185.1` source (`SSAARenderPass.js`/`SSAAPassNode.js`,
 * both `Math.max(0, Math.min(this.sampleLevel, 5))`). Rounds up (never
 * down) so an authored count is never silently under-sampled, then clamps
 * into that same `0` to `5` range.
 */
export function resolveSampleLevel(sampleCount: number): number {
  const level = Math.ceil(Math.log2(Math.max(1, sampleCount)));
  return Math.max(0, Math.min(level, 5));
}
