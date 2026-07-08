import type { AnimatableTransform } from "../scene-graph/primitives.js";
import type { TextGlowConfig, TextOutlineConfig, TextShadowConfig, TextStaggerConfig } from "../scene-graph/scene-node.js";
import type { TextProps } from "./text.js";

/**
 * One named typography starting point: a `Partial<TextProps>` (never
 * `id`/`content`, always caller-supplied) bundling `fontSize`, `transform`,
 * and a tasteful `stagger`/`outline`/`glow`/`shadow` combination for one
 * common on-screen role - a title card, a broadcast-style lower third, a
 * subtitle-style caption, or a punchy kinetic word reveal (Phase 73's own
 * "type presets" deliverable; "type" here is typography/type-design
 * terminology, not a TypeScript type). Spread into `Text({ id, ...preset,
 * content })`, or spread and override (`{ ...TYPE_PRESETS.title, fontSize:
 * 120 }`), mirroring `PBR_PRESETS`/`POST_PROCESSING_LOOK_PRESETS`'s own
 * "starting point to author from, not deep-merged with" convention.
 *
 * `transform.position` assumes a typical camera framing (an origin-facing
 * camera a handful of units back, matching every curated example scene in
 * this codebase - see `packages/schema/examples/rtl-latin-lower-third.scene.json`
 * for the exact lower-third position this preset's own `lowerThird` entry
 * matches): a caller with a different camera setup should override
 * `transform.position` for their own framing, the same way a caller with a
 * different color scheme overrides `PBR_PRESETS.brushedMetal.baseColor`.
 */
export type TypePreset = Partial<TextProps>;

/**
 * A curated library of type presets covering this phase's own required
 * scope ("title, lower third, caption, kinetic word reveal"). Every
 * `stagger` here groups by `"word"` (or, for `caption`, `"line"`) rather
 * than `"character"`/`"grapheme"`: a per-character reveal reads naturally
 * left-to-right only for that specific script's own visual order, while
 * per-word/per-line staggering keys off `TextUnit`'s own reading-order
 * index (see `TextStaggerConfig`'s own doc and `computeStaggerRanks`),
 * which is already correct for right-to-left and complex scripts (Phase
 * 73's own task 4) - `packages/schema/examples/rtl-latin-lower-third.scene.json`
 * exercises exactly this "word" grouping with real Arabic content.
 */
export const TYPE_PRESETS: Record<string, TypePreset> = {
  /** A large, centered title card: a slow, weighty word-by-word rise with a soft glow. */
  title: {
    fontSize: 96,
    stagger: {
      preset: "fadeInUp",
      grouping: "word",
      startFrame: 0,
      delayFrames: 4,
      durationFrames: 20,
      easing: "easeOutCubic",
    } satisfies TextStaggerConfig,
    glow: { radius: 0.06, color: [1, 1, 1, 1], intensity: 0.5 } satisfies TextGlowConfig,
  },
  /** A broadcast-style lower third: positioned toward the bottom-left of frame, with a drop shadow for legibility over moving video. */
  lowerThird: {
    transform: { position: [-6, -3, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } satisfies AnimatableTransform,
    fontSize: 48,
    stagger: {
      preset: "fadeInUp",
      grouping: "word",
      startFrame: 0,
      delayFrames: 3,
      durationFrames: 15,
      easing: "easeOutCubic",
    } satisfies TextStaggerConfig,
    shadow: { offsetX: 0.03, offsetY: -0.03, blur: 0.02, color: [0, 0, 0, 0.6] } satisfies TextShadowConfig,
  },
  /** A subtitle-style caption: bottom-center, a single quick line-fade (never a per-word reveal, which would slow reading down), with an outline for legibility over any background. */
  caption: {
    transform: { position: [0, -3.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } satisfies AnimatableTransform,
    fontSize: 32,
    stagger: {
      preset: "lineReveal",
      grouping: "line",
      startFrame: 0,
      delayFrames: 0,
      durationFrames: 8,
      easing: "easeOutCubic",
    } satisfies TextStaggerConfig,
    outline: { width: 0.04, color: [0, 0, 0, 1] } satisfies TextOutlineConfig,
  },
  /** A punchy, energetic word-by-word reveal: a snappier delay and an overshooting "back" ease for a kinetic-typography feel. */
  kineticWordReveal: {
    fontSize: 80,
    stagger: {
      preset: "fadeInUp",
      grouping: "word",
      startFrame: 0,
      delayFrames: 5,
      durationFrames: 12,
      easing: "easeOutBack",
      distance: 0.8,
    } satisfies TextStaggerConfig,
  },
};
