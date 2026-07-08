import type { PathTracingConfig, RenderQualityTier } from "@cadra/core";

/**
 * The `samples` default at `"final"` tier: high enough for a converged,
 * noise-free image on typical interior/exterior scenes without an authored
 * override. Mirrors `resolveSampleCountForTier`'s own preview/final split
 * in `@cadra/renderer` (`temporal-accumulation.ts`), scaled up because
 * unbiased path tracing needs far more samples than SSAA jitter to
 * converge.
 */
const FINAL_DEFAULT_SAMPLES = 256;

/** The `samples` default at `"preview"` tier: fast enough for interactive iteration, deliberately noisy. */
const PREVIEW_DEFAULT_SAMPLES = 16;

/** `PathTracingConfig.bounces`'s own default, matching that field's documented `5`. */
const DEFAULT_BOUNCES = 5;

/**
 * Resolves `PathTracingConfig.samples` for `tier`: the authored value if
 * present, otherwise `tier`'s own default. Pure and deterministic - the
 * same `(tier, samples)` pair always resolves to the same result.
 */
export function resolveSampleBudgetForTier(tier: RenderQualityTier, samples: number | undefined): number {
  if (samples !== undefined) {
    return samples;
  }
  return tier === "preview" ? PREVIEW_DEFAULT_SAMPLES : FINAL_DEFAULT_SAMPLES;
}

/** `PathTracingConfig`, fully resolved: every field defaulted, ready to drive `renderPathTracedFrame` directly. */
export interface ResolvedPathTracingConfig {
  tier: RenderQualityTier;
  samples: number;
  bounces: number;
}

/**
 * Resolves a composition's own `PathTracingConfig` (`@cadra/core`),
 * defaulting every field. `config` may be `undefined` (an author who sets
 * `renderMode: "pathTraced"` without a `pathTracing` block gets every
 * default). Mirrors `resolvePostProcessing`'s own shape in `@cadra/renderer`
 * (`post-processing-pipeline.ts`).
 */
export function resolvePathTracingConfig(config: PathTracingConfig | undefined): ResolvedPathTracingConfig {
  const tier = config?.tier ?? "final";
  return {
    tier,
    samples: resolveSampleBudgetForTier(tier, config?.samples),
    bounces: config?.bounces ?? DEFAULT_BOUNCES,
  };
}
