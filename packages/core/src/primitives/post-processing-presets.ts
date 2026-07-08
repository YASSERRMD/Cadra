import type { PostEffectConfig } from "../scene-graph/timeline.js";

/**
 * Named `CompositionPostProcessing.effects` starting points, mirroring
 * `PBR_PRESETS`'s own "spread and override" convention: authored as
 * `postProcessing: { effects: POST_PROCESSING_LOOK_PRESETS.cinematic }`, or
 * spread and extended (`effects: [...POST_PROCESSING_LOOK_PRESETS.cinematic,
 * { type: "sharpen", amount: 0.3 }]`). Every value here is a plain
 * `PostEffectConfig[]` (no keyframe track), since a preset is a starting
 * point to author from, not itself animated.
 */
export const POST_PROCESSING_LOOK_PRESETS: Record<string, PostEffectConfig[]> = {
  cinematic: [
    { type: "bloom", threshold: 0.85, intensity: 0.6, radius: 0.35 },
    { type: "vignette", darkness: 0.5, offset: 1.1 },
    { type: "filmGrain", intensity: 0.15 },
  ],
  dreamy: [
    { type: "bloom", threshold: 0.7, intensity: 1.1, radius: 0.6 },
    { type: "depthOfField", focusDistance: 10, aperture: 0.05, maxBlur: 1.5 },
    { type: "chromaticAberration", intensity: 0.3 },
  ],
  vintage: [
    { type: "vignette", darkness: 0.7, offset: 1.3 },
    { type: "filmGrain", intensity: 0.45 },
    { type: "chromaticAberration", intensity: 0.5 },
    { type: "lensDistortion", amount: -0.08 },
  ],
};
