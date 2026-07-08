import type { SceneNode } from "./scene-node.js";

/**
 * A composition-level transition applied as a clip comes in.
 *
 * `'cut'` (an instant switch with no blending) is deliberately not a variant
 * here: it is simply the absence of `Clip.transitionIn`, since there is
 * nothing to model for an instant cut. `direction` is only meaningful for
 * `'wipe'` (which edge the wipe sweeps in from); it must be omitted for
 * `'fade'` and `'crossDissolve'`, both of which are directionless blends.
 *
 * This type only carries the blend/progress metadata a timeline resolver
 * needs (see `resolveTransitionBlend`); actually rendering the visual effect
 * (a wipe's spatial mask, a shader-based cross-dissolve) is a future
 * renderer concern, out of scope for the timeline engine.
 */
export interface Transition {
  type: "fade" | "wipe" | "crossDissolve";
  /** How many frames the transition takes to complete, once the incoming clip starts. */
  durationInFrames: number;
  /** Which edge a `'wipe'` sweeps in from. Only meaningful (and only allowed) for `type: 'wipe'`. */
  direction?: "left" | "right" | "up" | "down";
}

/**
 * A single piece of content placed on a `Track`.
 *
 * `startFrame` and `durationInFrames` are both integer frame counts, never
 * wall-clock time: the scene graph must be reproducible from frame index
 * alone, and "integer frames plus an explicit fps" is the one time
 * representation every later phase (deterministic clock, timeline resolver,
 * renderer) is built to consume.
 */
export interface Clip {
  id: string;
  /** The frame, relative to the start of its composition, this clip begins on. */
  startFrame: number;
  /** How many frames this clip is visible for. */
  durationInFrames: number;
  /** The root of the scene-node subtree this clip contributes to the graph. */
  node: SceneNode;
  /**
   * Optional transition this clip blends in with, overlapping the end of
   * whichever clip precedes it on the same track (if any). Omitted means an
   * instant cut: the clip simply appears at full opacity on `startFrame`.
   */
  transitionIn?: Transition;
}

/** An ordered lane of non-overlapping-by-convention clips. */
export interface Track {
  id: string;
  /** Optional human-readable label, purely for authoring and debugging. */
  name?: string;
  clips: Clip[];
}

/**
 * A linear ramp applied at the start (`fadeIn`) or end (`fadeOut`) of an
 * `AudioClip`'s own window. Just a duration: the ramp's shape (gain 0 to
 * `clip.gain` for `fadeIn`, `clip.gain` to 0 for `fadeOut`) is fixed, computed
 * by `computeGainAtLocalFrame` (see `../audio/gain-envelope.js`) rather than
 * being itself a configurable curve. A richer per-fade easing curve is a
 * reasonable future extension, not needed yet.
 */
export interface AudioFadeEnvelope {
  durationInFrames: number;
}

/**
 * A single piece of audio content placed on an `AudioTrack`.
 *
 * Mirrors `Clip`'s integer-frame, half-open-window convention:
 * `startFrame`/`durationInFrames` place this clip on the composition's
 * timeline exactly like `Clip` does, and `resolveSequenceFrame` (the same
 * helper `Clip` visibility uses) applies unchanged here too.
 *
 * `assetRef` names the source audio asset (an `AssetDescriptor.url`, or
 * whatever id scheme the asset pipeline uses); this module stays
 * environment-agnostic and never loads or decodes the referenced bytes
 * itself, matching how `ImageNode`/`MeshNode` reference assets by id/url
 * rather than embedding them.
 *
 * `trimStartFrames` (default `0`) is how many frames into the *source* audio
 * playback begins: distinct from `startFrame`, which is where the clip sits
 * on the *composition* timeline. `gain` (default `1`) is a linear multiplier
 * applied to the source audio's amplitude. `fadeIn`/`fadeOut` are optional
 * ramps at the clip's own start/end; see `computeGainAtLocalFrame` for the
 * exact ramp math and how a clip too short for its authored fade durations is
 * handled.
 */
export interface AudioClip {
  id: string;
  /** The frame, relative to the start of its composition, this clip begins on. */
  startFrame: number;
  /** How many frames this clip plays for. */
  durationInFrames: number;
  /** Identifies the source audio asset this clip plays. */
  assetRef: string;
  /** How many frames into the source audio playback begins. Defaults to `0`. */
  trimStartFrames?: number;
  /** Linear gain multiplier applied to the source audio. Defaults to `1`. */
  gain?: number;
  /** Optional ramp from silence up to `gain` at the start of this clip's window. */
  fadeIn?: AudioFadeEnvelope;
  /** Optional ramp from `gain` down to silence at the end of this clip's window. */
  fadeOut?: AudioFadeEnvelope;
}

/** An ordered lane of non-overlapping-by-convention audio clips. */
export interface AudioTrack {
  id: string;
  /** Optional human-readable label, purely for authoring and debugging. */
  name?: string;
  clips: AudioClip[];
}

/**
 * Names which `CameraNode` is the active camera for a window of frames on a
 * `Composition`'s `activeCameraTrack`.
 *
 * `startFrame` and `durationInFrames` are integer frame counts with the same
 * half-open-interval convention as `Clip` (`resolveSequenceFrame` applies
 * unchanged to this shape). `cameraNodeId` is the id of a `CameraNode`
 * somewhere in this composition's resolved scene graph; resolving that id to
 * an actual camera transform/lens is a later phase's job (Phase 13's player
 * runtime), not the timeline engine's.
 */
export interface ActiveCameraEntry {
  startFrame: number;
  durationInFrames: number;
  cameraNodeId: string;
}

/**
 * A single renderable timeline: a fixed frame rate, a fixed integer duration,
 * a fixed output size, and the tracks of clips that populate it.
 *
 * `fps` and `durationInFrames` live here (not on `Project`) because time is
 * always relative to a specific composition: a `compositionRef` scene node
 * embeds one composition inside another, and each composition is free to run
 * at its own frame rate and length.
 */
export interface Composition {
  id: string;
  name: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  tracks: Track[];
  /**
   * Optional, separate lane naming which camera is "active" (i.e. which the
   * renderer should actually look through) at each frame, independent of
   * `tracks`: a camera can be renderable content on a `Track` without ever
   * being the active camera, and vice versa. Omitted means this composition
   * has no active-camera concept at all (e.g. a single fixed camera, or no
   * camera-driven rendering yet).
   */
  activeCameraTrack?: ActiveCameraEntry[];
  /**
   * Optional, separate lanes of audio content, independent of `tracks` (which
   * only ever carries visual scene-node content). Omitted means this
   * composition has no audio at all, matching every composition authored
   * before Phase 16. See `AudioTrack`/`AudioClip`.
   */
  audioTracks?: AudioTrack[];
  /**
   * A whole-composition color grade (exposure and white balance), applied
   * on top of this composition's own linear-light render, before tone
   * mapping. Fixed for the composition's entire length rather than
   * `Property<T>`-animatable: every other field on `Composition` itself
   * (`fps`/`width`/`height`/`durationInFrames`) is likewise a one-time
   * setting, not something that varies frame to frame. Omitted means a
   * neutral grade (0 exposure stops, 6500K/no tint white balance - a
   * no-op).
   */
  colorGrading?: CompositionColorGrading;
  /**
   * A whole-composition image-based lighting environment: ambient light and
   * reflections sourced from an equirectangular map, applied to every PBR
   * material in the render. Fixed for the composition's entire length,
   * exactly like `colorGrading` (see that field's own doc for why). Omitted
   * means no environment lighting at all (the pre-Phase-56 default).
   */
  environment?: CompositionEnvironment;
  /**
   * Whole-composition shadow and ambient-occlusion tuning: cascaded shadow
   * maps, ambient occlusion, and ground contact shadows. Fixed for the
   * composition's entire length, exactly like `colorGrading`/`environment`
   * (see `colorGrading`'s own doc for why). Omitted means ordinary
   * (non-cascaded) soft shadows per `LightNode.shadow` and no occlusion or
   * contact shadows at all (the pre-Phase-57 default).
   */
  shadowQuality?: CompositionShadowQuality;
  /**
   * The composition's own post-processing effect stack: an ordered list of
   * screen-space passes applied after the scene itself is drawn. Fixed for
   * the composition's entire length, exactly like `colorGrading` (see that
   * field's own doc for why a whole render pipeline setting is not
   * `Property<T>`-animatable; individual effect parameters inside
   * `PostEffectConfig` are still keyframeable per Phase 59 onward). Omitted
   * (or `effects: []`) means no post-processing pipeline runs at all: the
   * renderer draws exactly as it did before Phase 58, byte for byte.
   */
  postProcessing?: CompositionPostProcessing;
}

/**
 * A whole-composition color grade. See `Composition.colorGrading`'s own
 * doc for why this is a fixed, non-`Property<T>` setting.
 */
export interface CompositionColorGrading {
  /**
   * In photographic stops: each `+1` doubles the render's own brightness
   * before tone mapping, each `-1` halves it, matching a real camera's own
   * exposure compensation dial. Defaults to `0` (no adjustment).
   */
  exposureStops?: number;
  /**
   * The correlated color temperature, in Kelvin, this composition's own
   * scene illuminant is assumed to be, which the render is corrected
   * toward appearing neutral under (see `computeWhiteBalanceGain`).
   * Defaults to `6500` (standard daylight, the sRGB/D65 reference white -
   * approximately, not exactly, this correction's own true no-op point;
   * see `computeWhiteBalanceGain`'s own doc).
   */
  whiteBalanceTemperatureK?: number;
  /**
   * A green-magenta fine adjustment on top of `whiteBalanceTemperatureK`,
   * roughly `-1` (green) to `1` (magenta). Defaults to `0` (no tint
   * correction).
   */
  whiteBalanceTint?: number;
}

/**
 * A whole-composition image-based lighting environment. See
 * `Composition.environment`'s own doc for why this is a fixed,
 * non-`Property<T>` setting.
 */
export interface CompositionEnvironment {
  /**
   * Id of a registered equirectangular environment map, resolved against an
   * environment registry by the renderer. Two built-in refs, `"studio"` and
   * `"outdoor"`, are always available with no registry setup at all (see
   * `createDefaultEnvironmentRegistry` in `@cadra/renderer`).
   */
  envMapRef: string;
  /** Rotation around the vertical (world Y) axis, in radians. Defaults to `0`. */
  rotation?: number;
  /** Multiplies the environment's own contribution to diffuse and specular image-based lighting. Defaults to `1`. */
  intensity?: number;
  /** Whether the environment map is also visible as the rendered background, not just a lighting source. Defaults to `false` (lighting-only, e.g. for a product shot that wants believable reflections without showing the studio backdrop itself). */
  showBackground?: boolean;
  /** Multiplies the displayed background's own brightness, independent of `intensity`. Only meaningful when `showBackground` is `true`. Defaults to `1`. */
  backgroundIntensity?: number;
  /**
   * Projects the environment onto a virtual grounded skybox (a large sphere
   * flattened where it meets a ground plane) instead of an infinite sphere,
   * so reflections and the background both read as touching the ground -
   * useful for grounded product-style shots. Omitted means a standard
   * infinite-sphere environment.
   */
  groundProjection?: EnvironmentGroundProjection;
}

/** Ground-plane projection tuning for `CompositionEnvironment.groundProjection`. */
export interface EnvironmentGroundProjection {
  /**
   * How far above the ground the environment's own source photo was
   * captured from, in scene units; must be strictly positive (a larger
   * value magnifies the downward-facing part of the image, per Three.js's
   * own `GroundedSkybox`). The projected ground plane itself always ends up
   * at world Y `0`.
   */
  height: number;
  /** Radius of the virtual sky sphere; should comfortably contain the whole scene. Must be strictly positive. Defaults to `100`. */
  radius?: number;
}

/** A quality tier trading render cost against fidelity, applied to shadow map resolution, cascade count, and ambient occlusion sample density. */
export type ShadowQualityTier = "preview" | "final";

/**
 * Whole-composition shadow and ambient-occlusion tuning. See
 * `Composition.shadowQuality`'s own doc for why this is a fixed,
 * non-`Property<T>` setting.
 */
export interface CompositionShadowQuality {
  /** Trades render cost against fidelity for every setting below whose own field is left at its default. Defaults to `"final"`. */
  tier?: ShadowQualityTier;
  /**
   * Cascaded shadow maps for the scene's own directional lights, keeping
   * shadow crispness consistent across a large view distance instead of one
   * shadow map stretched thin. WebGPU-backend only: Three.js's own cascaded
   * shadow map implementations are backend-specific (`CSMShadowNode` for
   * WebGPU, `CSM` for WebGL2) and not drop-in-compatible with each other, so
   * on the WebGL2 fallback a directional light instead casts the ordinary,
   * non-cascaded soft shadow `LightNode.shadow` already provides. Omitted
   * means ordinary (non-cascaded) shadow mapping on both backends.
   */
  cascadedShadows?: CascadedShadowConfig;
  /** Screen-space ambient occlusion (contact darkening in creases and corners from nearby geometry, independent of any light). Omitted means no ambient occlusion. */
  ambientOcclusion?: AmbientOcclusionConfig;
  /** Soft contact-shadow decals under shadow-casting meshes, for grounded product-style shots. Omitted means none. */
  contactShadows?: ContactShadowConfig;
}

/** Cascaded shadow map tuning for `CompositionShadowQuality.cascadedShadows`. */
export interface CascadedShadowConfig {
  /** Number of shadow cascades. Higher values keep shadows crisp across a larger view distance, at a higher render cost. Defaults to `3` (`4` at the `"final"` quality tier). */
  cascades?: number;
  /** The far distance cascades extend to, in scene units. Defaults to `100000` (Three.js's own `CSMShadowNode` default). */
  maxFar?: number;
}

/** Ambient occlusion tuning for `CompositionShadowQuality.ambientOcclusion`. */
export interface AmbientOcclusionConfig {
  /** How far, in scene units, occlusion sampling reaches when looking for nearby occluders. Defaults to `1`. */
  radius?: number;
  /** Multiplies the occlusion's own darkening strength. Defaults to `1`. */
  intensity?: number;
}

/** Contact-shadow tuning for `CompositionShadowQuality.contactShadows`. */
export interface ContactShadowConfig {
  /** Height of the ground plane contact shadows are projected onto, in scene units. */
  groundY: number;
  /** Opacity of the contact shadow at its darkest point, `0` to `1`. Defaults to `0.5`. */
  opacity?: number;
  /** Radius of the soft contact-shadow decal, in scene units. Defaults to `2`. */
  radius?: number;
}

/**
 * A quality tier trading render cost against fidelity, applied to
 * post-processing (and, from Phase 60 onward, motion blur and temporal
 * accumulation sample counts). A separate type from `ShadowQualityTier`
 * despite sharing the same two literal values: shadows and post-processing
 * are tuned independently (a composition may want cheap preview shadows but
 * a full final-quality bloom, or vice versa), so collapsing them into one
 * shared tier would force them to always move together.
 */
export type RenderQualityTier = "preview" | "final";

/**
 * A local-contrast sharpening pass (unsharp mask): brightens each pixel
 * relative to the average of its four neighbors, scaled by `amount`. The one
 * concrete `PostEffectConfig` variant Phase 58 ships, purely to prove the
 * post-processing backbone actually runs a real, deterministic, animatable
 * effect; Phase 59 onward adds the named cinematic effects (bloom, depth of
 * field, chromatic aberration, vignette, film grain, lens distortion) as
 * further variants of the same union.
 */
export interface SharpenEffectConfig {
  type: "sharpen";
  /** Strength of the sharpening effect. `0` is a no-op. Defaults to `0.5`. */
  amount?: number;
}

/**
 * A bloom pass: extracts pixels above `threshold` (in linear scene-referred
 * HDR, before tone mapping - see `PostEffectConfig`'s own doc for why bloom
 * is a pre-tonemap effect), blurs them, and adds the result back over the
 * scene, the classic "bright things glow" cinematic look.
 */
export interface BloomEffectConfig {
  type: "bloom";
  /** Luminance level above which a pixel starts contributing to the glow, in linear scene-referred HDR. Defaults to `0.85`. */
  threshold?: number;
  /** Multiplies the glow's own brightness once added back over the scene. Defaults to `1`. */
  intensity?: number;
  /** How far the glow spreads from a bright pixel, roughly in screen-relative units. Defaults to `0.4`. */
  radius?: number;
}

/**
 * A depth of field pass: blurs the scene away from `focusDistance`, driven by
 * a real bokeh model over the scene's own depth buffer (not a flat blur), in
 * linear scene-referred HDR (see `PostEffectConfig`'s own doc for why depth
 * of field is a pre-tonemap effect - correct-looking bokeh highlights need
 * HDR headroom above 1.0).
 */
export interface DepthOfFieldEffectConfig {
  type: "depthOfField";
  /** Distance from the camera, in scene units, that stays in sharp focus. Defaults to `10`. */
  focusDistance?: number;
  /** How wide the lens opening is: larger values blur out-of-focus regions more strongly, mirroring a real camera's own aperture. Defaults to `0.025`. */
  aperture?: number;
  /** Caps how far the blur can spread, independent of `aperture`. Defaults to `1`. */
  maxBlur?: number;
}

/**
 * A chromatic aberration pass: shifts the final image's color channels apart
 * slightly, the color fringing a real camera lens produces at high contrast
 * edges. Display-referred (post-tonemap - see `PostEffectConfig`'s own doc):
 * this is a lens/sensor artifact on the image an audience actually sees, not
 * a property of the scene's own lighting.
 */
export interface ChromaticAberrationEffectConfig {
  type: "chromaticAberration";
  /** Strength of the channel shift. `0` is a no-op. Defaults to `0.5`. */
  intensity?: number;
}

/**
 * A vignette pass: darkens the final image toward its own corners.
 * Display-referred (post-tonemap - see `PostEffectConfig`'s own doc): a
 * framing/lens characteristic of the image an audience actually sees.
 */
export interface VignetteEffectConfig {
  type: "vignette";
  /** How dark the corners get, 0 (no darkening) to 1 (fully black). Defaults to `1`. */
  darkness?: number;
  /** How far the darkening reaches in from the corners toward the center; larger values reach further. Defaults to `1`. */
  offset?: number;
}

/**
 * A film grain pass: adds fine, per-pixel photographic noise to the final
 * image, reseeded every frame from that frame's own integer index (never
 * `Math.random()` or a wall-clock timer - see
 * `computeFilmGrainSeed`/`FILM_GRAIN_SEED_MULTIPLIER` in `@cadra/renderer`),
 * so a given frame's grain is reproducible on every render while still
 * animating from frame to frame like real film stock. Display-referred
 * (post-tonemap - see `PostEffectConfig`'s own doc): a texture of the final
 * image itself, not the underlying scene lighting.
 */
export interface FilmGrainEffectConfig {
  type: "filmGrain";
  /** Strength of the noise. `0` is a no-op. Defaults to `0.35`. */
  intensity?: number;
}

/**
 * A lens distortion pass: warps the final image radially from its center,
 * the barrel (`amount > 0`) or pincushion (`amount < 0`) curvature a real
 * camera lens introduces. Display-referred (post-tonemap - see
 * `PostEffectConfig`'s own doc): a pure UV remap of the composited image, not
 * a scene-lighting effect, grouped with the other lens/sensor artifacts for
 * simplicity even though a geometric warp has no tone-mapping dependency of
 * its own.
 */
export interface LensDistortionEffectConfig {
  type: "lensDistortion";
  /** Distortion strength: positive bulges outward (barrel), negative pinches inward (pincushion), `0` is a no-op. Defaults to `0`. */
  amount?: number;
}

/**
 * A true velocity-buffer motion blur pass: smears each pixel along its own
 * per-object screen-space motion (current frame's transform versus the
 * previous frame's, for both the camera and every mesh, rotation included),
 * scaled by a real cine camera's own shutter-angle convention (`0` is no
 * blur, `180` the standard cinematic default exposing half the frame
 * interval, `360` the maximum, exposing the whole interval). Pre-tonemap
 * (see `PostEffectConfig`'s own doc): blurring the scene's own linear HDR
 * data, before bloom, is what lets a blurred bright highlight still bloom
 * correctly.
 *
 * WebGPU-backend only, and silently skipped (a no-op, not an error) on the
 * WebGL2 fallback: Three.js's own per-object velocity tracking
 * (`VelocityNode`, see `@cadra/renderer`) is TSL-node infrastructure with no
 * classic-material equivalent, the same class of backend asymmetry
 * `CompositionShadowQuality.cascadedShadows` already documents for the exact
 * same underlying reason (a WebGPU-only Three.js technique with no
 * hand-rollable WebGL2 counterpart worth the cost of building one from
 * scratch). Determinism depends on frames being rendered in strictly
 * increasing order with no skipped or repeated frame (each frame's own
 * velocity is computed from the immediately preceding rendered frame's own
 * transforms, not derived from the frame index alone) - true of this
 * project's own sequential final-render path, but not of arbitrary preview
 * scrubbing/seeking, where a blurred frame reached by a jump may show
 * incorrect blur once, self-correcting the next sequential frame after it.
 */
export interface MotionBlurEffectConfig {
  type: "motionBlur";
  /** Shutter angle in degrees, `0` to `360`. Defaults to `180`. */
  shutterAngle?: number;
  /** Samples taken along each pixel's own velocity vector. Higher is smoother and more expensive. Defaults to `16`. */
  samples?: number;
}

/**
 * One configured entry in `CompositionPostProcessing.effects`. A
 * discriminated union on `type`, growing by one variant per effect Phase 59
 * onward adds. Which side of tone mapping a given `type` renders on (linear
 * scene-referred HDR versus the final display-referred image) is an inherent
 * property of that effect, decided by the renderer, not an authorable field
 * here: getting it wrong would silently clip or wash out the effect, so it is
 * not something a scene author or agent can misconfigure. `bloom`,
 * `depthOfField`, and `motionBlur` render pre-tonemap; `sharpen`,
 * `chromaticAberration`, `vignette`, `filmGrain`, and `lensDistortion` render
 * post-tonemap.
 */
export type PostEffectConfig =
  | SharpenEffectConfig
  | BloomEffectConfig
  | DepthOfFieldEffectConfig
  | ChromaticAberrationEffectConfig
  | VignetteEffectConfig
  | FilmGrainEffectConfig
  | LensDistortionEffectConfig
  | MotionBlurEffectConfig;

/**
 * A whole-composition post-processing effect stack. See
 * `Composition.postProcessing`'s own doc for why this is a fixed,
 * non-`Property<T>` setting.
 */
export interface CompositionPostProcessing {
  /** Trades render cost against fidelity for whichever effect in `effects` has an expensive quality knob of its own. Defaults to `"final"`. */
  tier?: RenderQualityTier;
  /** The effect stack, applied in array order within each effect's own fixed pre/post-tonemap stage. An empty array is a no-op, identical to omitting `postProcessing` entirely. */
  effects: PostEffectConfig[];
}

/** The top-level authoring unit: a named collection of compositions. */
export interface Project {
  id: string;
  name: string;
  compositions: Composition[];
}
