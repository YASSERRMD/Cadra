import type {
  ActiveCameraEntry,
  AmbientOcclusionConfig,
  AudioClip,
  AudioFadeEnvelope,
  AudioTrack,
  BloomEffectConfig,
  CascadedShadowConfig,
  ChromaticAberrationEffectConfig,
  Clip,
  ColorGradeEffectConfig,
  Composition,
  CompositionColorGrading,
  CompositionEnvironment,
  CompositionPostProcessing,
  CompositionRenderMode,
  CompositionShadowQuality,
  ContactShadowConfig,
  DepthOfFieldEffectConfig,
  EnvironmentGroundProjection,
  FilmGrainEffectConfig,
  LensDistortionEffectConfig,
  LutEffectConfig,
  MotionBlurEffectConfig,
  PathTracingConfig,
  PostEffectConfig,
  Project,
  RenderQualityTier,
  ShadowQualityTier,
  SharpenEffectConfig,
  Track,
  Transition,
  VignetteEffectConfig,
} from "@cadra/core";
import { z } from "zod";

import { sceneNodeSchema } from "./scene-node.js";

/**
 * Zod mirror of `Transition`, `Clip`, `Track`, `AudioFadeEnvelope`,
 * `AudioClip`, `AudioTrack`, `ActiveCameraEntry`, `Composition`, and
 * `Project` in `@cadra/core`'s `scene-graph/timeline.ts`.
 *
 * `startFrame` and `durationInFrames` (on `Clip`, `AudioClip`, and
 * `ActiveCameraEntry`), `durationInFrames` (on `Transition` and
 * `AudioFadeEnvelope`), `trimStartFrames` (on `AudioClip`), and `fps`,
 * `durationInFrames`, `width`, and `height` (on `Composition`) are all
 * integer frame/pixel counts, never wall-clock time or fractional pixels,
 * consistent with the integer-frame convention the Phase 3 deterministic
 * clock model is built around. Each is validated with `.int()` plus a
 * positivity constraint appropriate to the field: frame counts and
 * dimensions must be strictly positive, `startFrame`/`trimStartFrames` may
 * be zero but never negative.
 */

/** A compile-time-only equality check between two types, with no runtime cost. */
type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Forces `T` to be exactly the literal type `true`, or the file fails to typecheck. */
type AssertTrue<T extends true> = T;

/**
 * A composition-level transition applied as a clip comes in, mirroring
 * `Transition` in `@cadra/core`.
 *
 * `direction` is only meaningful for `type: 'wipe'`: `.superRefine` below
 * rejects a `'wipe'` transition missing `direction`, and rejects `direction`
 * present on a `'fade'` or `'crossDissolve'` transition, and rejects a
 * non-positive `durationInFrames` (a transition must take at least one
 * frame to have anything to blend).
 */
export const transitionSchema = z
  .strictObject({
    type: z
      .enum(["fade", "wipe", "crossDissolve"])
      .describe("Which kind of transition this is. 'cut' is the absence of a transition."),
    durationInFrames: z
      .number()
      .int()
      .positive()
      .describe("How many frames the transition takes to complete, once the incoming clip starts."),
    direction: z
      .enum(["left", "right", "up", "down"])
      .optional()
      .describe(
        "Which edge a 'wipe' sweeps in from. Only meaningful (and only allowed) for type: 'wipe'.",
      ),
  })
  .superRefine((transition, ctx) => {
    if (transition.type === "wipe" && transition.direction === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A 'wipe' transition requires a 'direction'.",
        path: ["direction"],
      });
    }
    if (transition.type !== "wipe" && transition.direction !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `'direction' is only meaningful for a 'wipe' transition, not '${transition.type}'.`,
        path: ["direction"],
      });
    }
  });

type _CheckTransition = AssertTrue<AssertEqual<z.infer<typeof transitionSchema>, Transition>>;

/**
 * A single piece of content placed on a `Track`.
 *
 * `startFrame` and `durationInFrames` are both integer frame counts, never
 * wall-clock time: the scene graph must be reproducible from frame index
 * alone.
 */
export const clipSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this clip within the project."),
  startFrame: z
    .number()
    .int()
    .min(0)
    .describe("The frame, relative to the start of its composition, this clip begins on."),
  durationInFrames: z
    .number()
    .int()
    .positive()
    .describe("How many frames this clip is visible for."),
  node: sceneNodeSchema.describe("The root of the scene-node subtree this clip contributes."),
  transitionIn: transitionSchema
    .optional()
    .describe("Optional transition this clip blends in with. Omitted means an instant cut."),
});

type _CheckClip = AssertTrue<AssertEqual<z.infer<typeof clipSchema>, Clip>>;

/** An ordered lane of non-overlapping-by-convention clips. */
export const trackSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this track within the project."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  clips: z.array(clipSchema).describe("The ordered clips placed on this track."),
});

type _CheckTrack = AssertTrue<AssertEqual<z.infer<typeof trackSchema>, Track>>;

/**
 * A linear fade ramp at the start or end of an `AudioClip`'s window,
 * mirroring `AudioFadeEnvelope` in `@cadra/core`. `durationInFrames` must be
 * a non-negative integer; whether it is *reasonable* relative to the clip it
 * belongs to (not longer than the clip's own `durationInFrames`) is enforced
 * by `audioClipSchema`'s `.superRefine` below, since a bare envelope has no
 * clip context of its own to check against.
 */
export const audioFadeEnvelopeSchema = z.strictObject({
  durationInFrames: z
    .number()
    .int()
    .min(0)
    .describe("How many frames this fade ramp takes to complete."),
});

type _CheckAudioFadeEnvelope = AssertTrue<
  AssertEqual<z.infer<typeof audioFadeEnvelopeSchema>, AudioFadeEnvelope>
>;

/**
 * A single piece of audio content placed on an `AudioTrack`, mirroring
 * `AudioClip` in `@cadra/core`. Same integer-frame, half-open-window
 * convention as `Clip`.
 *
 * `.superRefine` enforces: `gain` (when present) must be non-negative (a
 * negative amplitude multiplier has no meaningful interpretation); and each
 * of `fadeIn`/`fadeOut` (when present), individually, must not exceed this
 * clip's own `durationInFrames` (a fade literally longer than the clip it
 * belongs to is not a fade, since it would never complete). Deliberately
 * *not* enforced here: `fadeIn.durationInFrames + fadeOut.durationInFrames`
 * exceeding `durationInFrames` (the two fades overlapping) is accepted, not
 * rejected. `computeGainAtLocalFrame` in `@cadra/core` already defines
 * well-specified, sensible behavior for that case (each fade clamps to at
 * most half the clip's duration, so the two ramps meet at, but never cross,
 * the midpoint), so an author writing "fade this whole short clip in and
 * out" without doing that arithmetic themselves is intentionally supported,
 * not an error.
 */
export const audioClipSchema = z
  .strictObject({
    id: z.string().describe("Unique identifier for this clip within the project."),
    startFrame: z
      .number()
      .int()
      .min(0)
      .describe("The frame, relative to the start of its composition, this clip begins on."),
    durationInFrames: z
      .number()
      .int()
      .positive()
      .describe("How many frames this clip plays for."),
    assetRef: z.string().describe("Identifies the source audio asset this clip plays."),
    trimStartFrames: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("How many frames into the source audio playback begins. Defaults to 0."),
    gain: z
      .number()
      .optional()
      .describe("Linear gain multiplier applied to the source audio. Defaults to 1."),
    fadeIn: audioFadeEnvelopeSchema
      .optional()
      .describe("Optional ramp from silence up to gain at the start of this clip's window."),
    fadeOut: audioFadeEnvelopeSchema
      .optional()
      .describe("Optional ramp from gain down to silence at the end of this clip's window."),
  })
  .superRefine((clip, ctx) => {
    if (clip.gain !== undefined && clip.gain < 0) {
      ctx.addIssue({
        code: "custom",
        message: `gain must be non-negative, got ${clip.gain}.`,
        path: ["gain"],
      });
    }
    if (clip.fadeIn !== undefined && clip.fadeIn.durationInFrames > clip.durationInFrames) {
      ctx.addIssue({
        code: "custom",
        message:
          `fadeIn.durationInFrames (${clip.fadeIn.durationInFrames}) must not exceed this ` +
          `clip's own durationInFrames (${clip.durationInFrames}).`,
        path: ["fadeIn", "durationInFrames"],
      });
    }
    if (clip.fadeOut !== undefined && clip.fadeOut.durationInFrames > clip.durationInFrames) {
      ctx.addIssue({
        code: "custom",
        message:
          `fadeOut.durationInFrames (${clip.fadeOut.durationInFrames}) must not exceed this ` +
          `clip's own durationInFrames (${clip.durationInFrames}).`,
        path: ["fadeOut", "durationInFrames"],
      });
    }
  });

type _CheckAudioClip = AssertTrue<AssertEqual<z.infer<typeof audioClipSchema>, AudioClip>>;

/** An ordered lane of non-overlapping-by-convention audio clips, mirroring `AudioTrack` in `@cadra/core`. */
export const audioTrackSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this track within the project."),
  name: z
    .string()
    .optional()
    .describe("Optional human-readable label, purely for authoring and debugging."),
  clips: z.array(audioClipSchema).describe("The ordered audio clips placed on this track."),
});

type _CheckAudioTrack = AssertTrue<AssertEqual<z.infer<typeof audioTrackSchema>, AudioTrack>>;

/**
 * Names which `CameraNode` is active for a window of frames on a
 * `Composition`'s `activeCameraTrack`, mirroring `ActiveCameraEntry` in
 * `@cadra/core`. Same integer-frame-count convention as `Clip`.
 */
export const activeCameraEntrySchema = z.strictObject({
  startFrame: z
    .number()
    .int()
    .min(0)
    .describe("The frame, relative to the start of the composition, this entry begins on."),
  durationInFrames: z
    .number()
    .int()
    .positive()
    .describe("How many frames this entry's camera stays active for."),
  cameraNodeId: z
    .string()
    .describe(
      "Id of the CameraNode active for this window, resolved elsewhere in the scene graph.",
    ),
});

type _CheckActiveCameraEntry = AssertTrue<
  AssertEqual<z.infer<typeof activeCameraEntrySchema>, ActiveCameraEntry>
>;

/** Zod mirror of `CompositionColorGrading` in `@cadra/core`'s `scene-graph/timeline.ts`. */
export const compositionColorGradingSchema = z.strictObject({
  exposureStops: z
    .number()
    .optional()
    .describe("Photographic stops of exposure adjustment. Defaults to 0 (no adjustment)."),
  whiteBalanceTemperatureK: z
    .number()
    .optional()
    .describe("Assumed scene illuminant color temperature, in Kelvin. Defaults to 6500."),
  whiteBalanceTint: z
    .number()
    .optional()
    .describe("Green-magenta fine adjustment, roughly -1 to 1. Defaults to 0 (no tint)."),
});

type _CheckCompositionColorGrading = AssertTrue<
  AssertEqual<z.infer<typeof compositionColorGradingSchema>, CompositionColorGrading>
>;

/** Ground-plane projection tuning for `compositionEnvironmentSchema.groundProjection`, mirroring `EnvironmentGroundProjection`. */
export const environmentGroundProjectionSchema = z.strictObject({
  height: z
    .number()
    .describe(
      "How far above the ground the environment's own source photo was captured from, in scene units; " +
        "must be strictly positive. The projected ground plane itself always ends up at world Y 0.",
    ),
  radius: z
    .number()
    .optional()
    .describe("Radius of the virtual sky sphere; should comfortably contain the whole scene. Defaults to 100."),
});

type _CheckEnvironmentGroundProjection = AssertTrue<
  AssertEqual<z.infer<typeof environmentGroundProjectionSchema>, EnvironmentGroundProjection>
>;

/** A whole-composition image-based lighting environment, mirroring `CompositionEnvironment`. */
export const compositionEnvironmentSchema = z.strictObject({
  envMapRef: z
    .string()
    .describe("Id of a registered equirectangular environment map, resolved against an environment registry."),
  rotation: z
    .number()
    .optional()
    .describe("Rotation around the vertical (world Y) axis, in radians. Defaults to 0."),
  intensity: z
    .number()
    .optional()
    .describe("Multiplies the environment's own contribution to diffuse and specular image-based lighting. Defaults to 1."),
  showBackground: z
    .boolean()
    .optional()
    .describe("Whether the environment map is also visible as the rendered background. Defaults to false."),
  backgroundIntensity: z
    .number()
    .optional()
    .describe("Multiplies the displayed background's own brightness. Only meaningful when showBackground is true. Defaults to 1."),
  groundProjection: environmentGroundProjectionSchema
    .optional()
    .describe("Optional grounded-skybox projection for grounded product-style shots. Omitted means a standard infinite-sphere environment."),
});

type _CheckCompositionEnvironment = AssertTrue<
  AssertEqual<z.infer<typeof compositionEnvironmentSchema>, CompositionEnvironment>
>;

/** A quality tier trading render cost against fidelity, mirroring `ShadowQualityTier`. */
export const shadowQualityTierSchema = z
  .enum(["preview", "final"])
  .describe("Trades render cost against fidelity for shadow map resolution, cascade count, and AO sample density.");

type _CheckShadowQualityTier = AssertTrue<
  AssertEqual<z.infer<typeof shadowQualityTierSchema>, ShadowQualityTier>
>;

/** Cascaded shadow map tuning for `compositionShadowQualitySchema.cascadedShadows`, mirroring `CascadedShadowConfig`. */
export const cascadedShadowConfigSchema = z.strictObject({
  cascades: z
    .number()
    .optional()
    .describe("Number of shadow cascades. Defaults to 3 (4 at the 'final' quality tier)."),
  maxFar: z
    .number()
    .optional()
    .describe("The far distance cascades extend to, in scene units. Defaults to 100000."),
});

type _CheckCascadedShadowConfig = AssertTrue<
  AssertEqual<z.infer<typeof cascadedShadowConfigSchema>, CascadedShadowConfig>
>;

/** Ambient occlusion tuning for `compositionShadowQualitySchema.ambientOcclusion`, mirroring `AmbientOcclusionConfig`. */
export const ambientOcclusionConfigSchema = z.strictObject({
  radius: z
    .number()
    .optional()
    .describe("How far, in scene units, occlusion sampling reaches when looking for nearby occluders. Defaults to 1."),
  intensity: z
    .number()
    .optional()
    .describe("Multiplies the occlusion's own darkening strength. Defaults to 1."),
});

type _CheckAmbientOcclusionConfig = AssertTrue<
  AssertEqual<z.infer<typeof ambientOcclusionConfigSchema>, AmbientOcclusionConfig>
>;

/** Contact-shadow tuning for `compositionShadowQualitySchema.contactShadows`, mirroring `ContactShadowConfig`. */
export const contactShadowConfigSchema = z.strictObject({
  groundY: z
    .number()
    .describe("Height of the ground plane contact shadows are projected onto, in scene units."),
  opacity: z
    .number()
    .optional()
    .describe("Opacity of the contact shadow at its darkest point, 0 to 1. Defaults to 0.5."),
  radius: z
    .number()
    .optional()
    .describe("Radius of the soft contact-shadow decal, in scene units. Defaults to 2."),
});

type _CheckContactShadowConfig = AssertTrue<
  AssertEqual<z.infer<typeof contactShadowConfigSchema>, ContactShadowConfig>
>;

/** Whole-composition shadow and ambient-occlusion tuning, mirroring `CompositionShadowQuality`. */
export const compositionShadowQualitySchema = z.strictObject({
  tier: shadowQualityTierSchema.optional().describe("Trades render cost against fidelity. Defaults to 'final'."),
  cascadedShadows: cascadedShadowConfigSchema
    .optional()
    .describe("Optional cascaded shadow maps for directional lights. WebGPU-backend only; see its own doc."),
  ambientOcclusion: ambientOcclusionConfigSchema
    .optional()
    .describe("Optional screen-space ambient occlusion."),
  contactShadows: contactShadowConfigSchema
    .optional()
    .describe("Optional soft contact-shadow decals for grounded product-style shots."),
});

type _CheckCompositionShadowQuality = AssertTrue<
  AssertEqual<z.infer<typeof compositionShadowQualitySchema>, CompositionShadowQuality>
>;

/** A quality tier trading render cost against fidelity, mirroring `RenderQualityTier`. See that type's own doc for why this is a separate schema from `shadowQualityTierSchema`. */
export const renderQualityTierSchema = z
  .enum(["preview", "final"])
  .describe("Trades render cost against fidelity for whichever post-processing effect has an expensive quality knob of its own.");

type _CheckRenderQualityTier = AssertTrue<AssertEqual<z.infer<typeof renderQualityTierSchema>, RenderQualityTier>>;

/** A local-contrast sharpening pass, mirroring `SharpenEffectConfig`. */
export const sharpenEffectConfigSchema = z.strictObject({
  type: z.literal("sharpen"),
  amount: z.number().optional().describe("Strength of the sharpening effect. 0 is a no-op. Defaults to 0.5."),
});

type _CheckSharpenEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof sharpenEffectConfigSchema>, SharpenEffectConfig>
>;

/** A bloom pass, mirroring `BloomEffectConfig`. */
export const bloomEffectConfigSchema = z.strictObject({
  type: z.literal("bloom"),
  threshold: z
    .number()
    .optional()
    .describe("Luminance level above which a pixel starts contributing to the glow, in linear scene-referred HDR. Defaults to 0.85."),
  intensity: z
    .number()
    .optional()
    .describe("Multiplies the glow's own brightness once added back over the scene. Defaults to 1."),
  radius: z
    .number()
    .optional()
    .describe("How far the glow spreads from a bright pixel, roughly in screen-relative units. Defaults to 0.4."),
});

type _CheckBloomEffectConfig = AssertTrue<AssertEqual<z.infer<typeof bloomEffectConfigSchema>, BloomEffectConfig>>;

/** A depth of field pass, mirroring `DepthOfFieldEffectConfig`. */
export const depthOfFieldEffectConfigSchema = z.strictObject({
  type: z.literal("depthOfField"),
  focusDistance: z
    .number()
    .optional()
    .describe("Distance from the camera, in scene units, that stays in sharp focus. Defaults to 10."),
  aperture: z
    .number()
    .optional()
    .describe("How wide the lens opening is: larger values blur out-of-focus regions more strongly. Defaults to 0.025."),
  maxBlur: z
    .number()
    .optional()
    .describe("Caps how far the blur can spread, independent of aperture. Defaults to 1."),
});

type _CheckDepthOfFieldEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof depthOfFieldEffectConfigSchema>, DepthOfFieldEffectConfig>
>;

/** A chromatic aberration pass, mirroring `ChromaticAberrationEffectConfig`. */
export const chromaticAberrationEffectConfigSchema = z.strictObject({
  type: z.literal("chromaticAberration"),
  intensity: z.number().optional().describe("Strength of the channel shift. 0 is a no-op. Defaults to 0.5."),
});

type _CheckChromaticAberrationEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof chromaticAberrationEffectConfigSchema>, ChromaticAberrationEffectConfig>
>;

/** A vignette pass, mirroring `VignetteEffectConfig`. */
export const vignetteEffectConfigSchema = z.strictObject({
  type: z.literal("vignette"),
  darkness: z
    .number()
    .optional()
    .describe("How dark the corners get, 0 (no darkening) to 1 (fully black). Defaults to 1."),
  offset: z
    .number()
    .optional()
    .describe("How far the darkening reaches in from the corners toward the center; larger values reach further. Defaults to 1."),
});

type _CheckVignetteEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof vignetteEffectConfigSchema>, VignetteEffectConfig>
>;

/** A film grain pass, mirroring `FilmGrainEffectConfig`. */
export const filmGrainEffectConfigSchema = z.strictObject({
  type: z.literal("filmGrain"),
  intensity: z.number().optional().describe("Strength of the noise. 0 is a no-op. Defaults to 0.35."),
});

type _CheckFilmGrainEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof filmGrainEffectConfigSchema>, FilmGrainEffectConfig>
>;

/** A lens distortion pass, mirroring `LensDistortionEffectConfig`. */
export const lensDistortionEffectConfigSchema = z.strictObject({
  type: z.literal("lensDistortion"),
  amount: z
    .number()
    .optional()
    .describe("Distortion strength: positive bulges outward (barrel), negative pinches inward (pincushion), 0 is a no-op. Defaults to 0."),
});

type _CheckLensDistortionEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof lensDistortionEffectConfigSchema>, LensDistortionEffectConfig>
>;

/** A true velocity-buffer motion blur pass, mirroring `MotionBlurEffectConfig`. WebGPU-backend only; see that type's own doc. */
export const motionBlurEffectConfigSchema = z.strictObject({
  type: z.literal("motionBlur"),
  shutterAngle: z.number().optional().describe("Shutter angle in degrees, 0 to 360. Defaults to 180."),
  samples: z
    .number()
    .optional()
    .describe("Samples taken along each pixel's own velocity vector. Higher is smoother and more expensive. Defaults to 16."),
});

type _CheckMotionBlurEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof motionBlurEffectConfigSchema>, MotionBlurEffectConfig>
>;

/** An `[r, g, b]` triple, mirroring `ColorGradeEffectConfig`'s own `lift`/`gamma`/`gain` fields. */
const rgbTripleSchema = z.tuple([z.number(), z.number(), z.number()]);

/** A three-way lift/gamma/gain color grading pass, mirroring `ColorGradeEffectConfig`. */
export const colorGradeEffectConfigSchema = z.strictObject({
  type: z.literal("colorGrade"),
  lift: rgbTripleSchema
    .optional()
    .describe("Shadow offset per channel, raising or lowering black level. [0, 0, 0] is a no-op."),
  gamma: rgbTripleSchema.optional().describe("Midtone power per channel. [1, 1, 1] is a no-op."),
  gain: rgbTripleSchema.optional().describe("Highlight multiplier per channel. [1, 1, 1] is a no-op."),
  saturation: z
    .number()
    .optional()
    .describe("Overall color intensity: 0 is grayscale, 1 is a no-op, above 1 oversaturates. Defaults to 1."),
  contrast: z.number().optional().describe("Contrast around the mid-gray pivot: 1 is a no-op. Defaults to 1."),
});

type _CheckColorGradeEffectConfig = AssertTrue<
  AssertEqual<z.infer<typeof colorGradeEffectConfigSchema>, ColorGradeEffectConfig>
>;

/** A 3D lookup table pass, mirroring `LutEffectConfig`. */
export const lutEffectConfigSchema = z.strictObject({
  type: z.literal("lut"),
  lutRef: z.string().describe("Id of a registered 3D LUT, resolved against a LUT registry."),
  intensity: z
    .number()
    .optional()
    .describe("Blends between the un-graded image (0) and the full LUT result (1). Defaults to 1."),
});

type _CheckLutEffectConfig = AssertTrue<AssertEqual<z.infer<typeof lutEffectConfigSchema>, LutEffectConfig>>;

/**
 * One configured entry in `compositionPostProcessingSchema.effects`, mirroring
 * `PostEffectConfig`. A discriminated union on `type`, growing by one variant
 * per effect Phase 59 onward adds.
 */
export const postEffectConfigSchema = z.discriminatedUnion("type", [
  sharpenEffectConfigSchema,
  bloomEffectConfigSchema,
  depthOfFieldEffectConfigSchema,
  chromaticAberrationEffectConfigSchema,
  vignetteEffectConfigSchema,
  filmGrainEffectConfigSchema,
  lensDistortionEffectConfigSchema,
  motionBlurEffectConfigSchema,
  colorGradeEffectConfigSchema,
  lutEffectConfigSchema,
]);

type _CheckPostEffectConfig = AssertTrue<AssertEqual<z.infer<typeof postEffectConfigSchema>, PostEffectConfig>>;

/** A whole-composition post-processing effect stack, mirroring `CompositionPostProcessing`. */
export const compositionPostProcessingSchema = z.strictObject({
  tier: renderQualityTierSchema.optional().describe("Trades render cost against fidelity. Defaults to 'final'."),
  effects: z
    .array(postEffectConfigSchema)
    .describe("The effect stack, applied in array order within each effect's own fixed pre/post-tonemap stage. An empty array is a no-op."),
  sampleCount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Sub-pixel-jittered camera samples accumulated into each output frame, rounded up to the nearest power of two, one to 32. Omitted or 1 means no accumulation.",
    ),
});

type _CheckCompositionPostProcessing = AssertTrue<
  AssertEqual<z.infer<typeof compositionPostProcessingSchema>, CompositionPostProcessing>
>;

/** Which renderer produces a composition's own final output, mirroring `CompositionRenderMode`. */
export const compositionRenderModeSchema = z
  .enum(["raster", "pathTraced"])
  .describe("Which renderer produces this composition's own final output. Preview always uses raster regardless of this field. Defaults to 'raster'.");

type _CheckCompositionRenderMode = AssertTrue<
  AssertEqual<z.infer<typeof compositionRenderModeSchema>, CompositionRenderMode>
>;

/** Path-traced render tuning, mirroring `PathTracingConfig`. Read only when `renderMode` is `"pathTraced"`. */
export const pathTracingConfigSchema = z.strictObject({
  tier: renderQualityTierSchema.optional().describe("Trades render cost against fidelity for samples's own default. Defaults to 'final'."),
  samples: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Samples accumulated per output frame. Higher is cleaner and slower. Tier-dependent default when omitted."),
  bounces: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum light bounce depth. Higher resolves more indirect light and reflections at a higher cost. Defaults to 5."),
  denoise: z
    .boolean()
    .optional()
    .describe(
      "Applies edge-aware denoising to the accumulated result once sampling finishes, trading a small amount of fine detail for a dramatically cleaner image at the same sample budget. Defaults to false.",
    ),
});

type _CheckPathTracingConfig = AssertTrue<AssertEqual<z.infer<typeof pathTracingConfigSchema>, PathTracingConfig>>;

/**
 * A single renderable timeline: a fixed frame rate, a fixed integer duration,
 * a fixed output size, and the tracks of clips that populate it.
 */
export const compositionSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this composition within the project."),
  name: z.string().describe("Human-readable name of this composition."),
  fps: z.number().int().positive().describe("Frames per second this composition runs at."),
  durationInFrames: z
    .number()
    .int()
    .positive()
    .describe("Total integer length of this composition, in frames."),
  width: z.number().int().positive().describe("Output width of this composition, in pixels."),
  height: z.number().int().positive().describe("Output height of this composition, in pixels."),
  tracks: z.array(trackSchema).describe("The tracks of clips that populate this composition."),
  activeCameraTrack: z
    .array(activeCameraEntrySchema)
    .optional()
    .describe("Optional lane naming which camera is active at each frame, independent of tracks."),
  audioTracks: z
    .array(audioTrackSchema)
    .optional()
    .describe("Optional lanes of audio content, independent of tracks."),
  colorGrading: compositionColorGradingSchema
    .optional()
    .describe("Optional whole-composition color grade (exposure and white balance)."),
  environment: compositionEnvironmentSchema
    .optional()
    .describe("Optional whole-composition image-based lighting environment."),
  shadowQuality: compositionShadowQualitySchema
    .optional()
    .describe("Optional whole-composition shadow and ambient-occlusion tuning."),
  postProcessing: compositionPostProcessingSchema
    .optional()
    .describe("Optional whole-composition post-processing effect stack."),
  renderMode: compositionRenderModeSchema.optional().describe("Optional render mode override. Defaults to 'raster'."),
  pathTracing: pathTracingConfigSchema
    .optional()
    .describe("Optional path-traced render tuning, read only when renderMode is 'pathTraced'."),
});

type _CheckComposition = AssertTrue<AssertEqual<z.infer<typeof compositionSchema>, Composition>>;

/** The top-level authoring unit: a named collection of compositions. */
export const projectSchema = z.strictObject({
  id: z.string().describe("Unique identifier for this project."),
  name: z.string().describe("Human-readable name of this project."),
  compositions: z
    .array(compositionSchema)
    .describe("The named compositions that make up this project."),
});

type _CheckProject = AssertTrue<AssertEqual<z.infer<typeof projectSchema>, Project>>;
