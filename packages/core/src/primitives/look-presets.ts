import type { AnimatableTransform, ColorRGBA } from "../scene-graph/primitives.js";
import type { LightType } from "../scene-graph/scene-node.js";
import type {
  Clip,
  Composition,
  CompositionColorGrading,
  CompositionEnvironment,
  CompositionPostProcessing,
  Track,
} from "../scene-graph/timeline.js";
import { Light } from "./light.js";
import { POST_PROCESSING_LOOK_PRESETS } from "./post-processing-presets.js";
import { Sequence } from "./sequence.js";

/**
 * One light a `LookPreset` adds to a composition, shaped exactly like
 * `LightProps` minus `id` (a caller assigns fresh, collision-free ids via
 * `applyLookPreset`'s own `generateId`) and minus `children` (a preset light
 * is always a bare leaf node, never a parent).
 */
export interface LookPresetLight {
  name?: string;
  transform?: AnimatableTransform;
  lightType?: LightType;
  color?: ColorRGBA;
  intensity?: number;
  castShadow?: boolean;
  /**
   * A preset-local, author-chosen key this light can be referenced by from
   * elsewhere in the *same* preset's own `postProcessing` - specifically,
   * a `GodRaysEffectConfig.lightNodeId` naming this exact string (see
   * `applyLookPreset`'s own doc for the substitution this drives). Distinct
   * from `name` (a free-text display label with no structural meaning):
   * this is a stable, mechanical identity a preset's own static data can
   * depend on, which `name` was never meant to guarantee. Never appears on
   * the real `LightNode` `applyLookPreset` produces - purely an authoring-
   * time indirection, resolved away before this preset's own lights and
   * `postProcessing` reach a real `Composition`.
   */
  presetLightRef?: string;
}

/**
 * A named, ready-to-apply cinematic starting point bundling a lighting rig,
 * post-processing stack, color grade, and image-based-lighting environment -
 * everything `Composition`-level a scene needs to already look intentional,
 * in one call (`applyLookPreset`), rather than an agent hand-assembling
 * lights, effects, and grading field by field. Mirrors `PBR_PRESETS`/
 * `POST_PROCESSING_LOOK_PRESETS`'s own "named starting point, not itself
 * animated" convention, just at the whole-composition level instead of one
 * material/effect-list.
 */
export interface LookPreset {
  lights: readonly LookPresetLight[];
  postProcessing?: CompositionPostProcessing;
  colorGrading?: CompositionColorGrading;
  environment?: CompositionEnvironment;
}

/**
 * The curated look-preset library: `cinematic` and `product` shipped in
 * Phase 72 (proving the mechanism end to end); `documentary`, `boldSocial`,
 * and `elegantTitle` shipped in Phase 73 (this codebase's own improvement
 * track's "full curated library" deliverable); `dynamicAction` added later,
 * the first preset to turn on `motionBlur` (`@cadra/renderer`'s own
 * velocity-buffer motion blur, real and independently tested via
 * `@cadra/golden-frames`' own `motionBlurScene`, but until now unreachable
 * through `apply_look_preset` - only authorable by hand-editing raw
 * `postProcessing.effects` JSON); `lightShafts` added later still, the
 * first preset to turn on `godRays` (`@cadra/renderer`'s own real,
 * independently tested volumetric-light-shaft effect) - see
 * `LookPresetLight.presetLightRef`'s own doc and `applyLookPreset`'s own
 * substitution step for the mechanism that makes a static preset's own
 * `godRays.lightNodeId` resolve to one of that same preset's own
 * (not-yet-generated at authoring time) light ids. Adding a new named
 * entry here later is a pure data addition, no mechanism change.
 */
export const LOOK_PRESETS: Record<string, LookPreset> = {
  /** A three-point-inspired key/fill/rim rig plus `POST_PROCESSING_LOOK_PRESETS.cinematic`: a general-purpose dramatic look for a title card or hero shot. */
  cinematic: {
    lights: [
      {
        name: "key",
        lightType: "directional",
        transform: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
        intensity: 2.2,
        castShadow: true,
      },
      {
        name: "fill",
        lightType: "ambient",
        intensity: 0.35,
      },
      {
        name: "rim",
        lightType: "point",
        transform: { position: [-3, 2, -4], rotation: [0, 0, 0], scale: [1, 1, 1] },
        color: [0.6, 0.7, 1, 1],
        intensity: 6,
      },
    ],
    postProcessing: { effects: POST_PROCESSING_LOOK_PRESETS.cinematic ?? [] },
  },
  /** A soft, even studio rig plus a neutral IBL environment and a shallow-depth-of-field post stack: a clean, believable hero-product look. */
  product: {
    lights: [
      {
        name: "key",
        lightType: "directional",
        transform: { position: [3, 4, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        intensity: 1.6,
        castShadow: true,
      },
      {
        name: "fill",
        lightType: "ambient",
        intensity: 0.6,
      },
    ],
    postProcessing: {
      effects: [
        { type: "depthOfField", focusDistance: 5, aperture: 0.03, maxBlur: 1 },
        { type: "sharpen", amount: 0.3 },
      ],
    },
    environment: { envMapRef: "studio", intensity: 1, showBackground: false },
  },
  /** A naturalistic, observational two-light rig (key plus fill, no rim - a rim light reads as "produced," not available-light) with a gentle desaturation and grain: a believable documentary/interview look. */
  documentary: {
    lights: [
      {
        name: "key",
        lightType: "directional",
        transform: { position: [3, 4, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
        intensity: 1.4,
      },
      {
        name: "fill",
        lightType: "ambient",
        intensity: 0.7,
      },
    ],
    postProcessing: {
      effects: [
        { type: "colorGrade", saturation: 0.9, contrast: 0.95 },
        { type: "filmGrain", intensity: 0.2 },
        { type: "vignette", darkness: 0.25, offset: 1.3 },
      ],
    },
  },
  /** A punchy, high-contrast rig plus a vibrant colored accent light and a saturated, sharpened grade: built for short-form social video, read at a glance on a small screen. */
  boldSocial: {
    lights: [
      {
        name: "key",
        lightType: "directional",
        transform: { position: [3, 5, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        intensity: 2.5,
        castShadow: true,
      },
      {
        name: "fill",
        lightType: "ambient",
        intensity: 0.4,
      },
      {
        name: "accent",
        lightType: "point",
        transform: { position: [-3, 1, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        color: [1, 0.3, 0.6, 1],
        intensity: 8,
      },
    ],
    postProcessing: {
      effects: [
        { type: "colorGrade", saturation: 1.3, contrast: 1.2 },
        { type: "sharpen", amount: 0.5 },
        { type: "vignette", darkness: 0.5, offset: 0.9 },
      ],
    },
  },
  /** A soft, even, restrained two-light rig with a gentle bloom and a cool, slightly desaturated grade, and deliberately no vignette (clean and even, not moody): a refined, high-end title-card look. */
  elegantTitle: {
    lights: [
      {
        name: "key",
        lightType: "directional",
        transform: { position: [2, 4, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
        intensity: 1.5,
      },
      {
        name: "fill",
        lightType: "ambient",
        intensity: 0.5,
      },
    ],
    postProcessing: {
      effects: [
        { type: "bloom", threshold: 0.8, intensity: 0.35, radius: 0.3 },
        { type: "colorGrade", saturation: 0.92, contrast: 1.05 },
      ],
    },
  },
  /** A high-energy two-light rig plus velocity-buffer motion blur, a punchy grade, and sharpening: built for fast-moving subjects (sports, action, kinetic product shots) where real per-object motion blur reads as "genuinely fast," not just "in frame." WebGPU-only, per `MotionBlurEffectConfig`'s own doc - a WebGL2 render silently renders this preset's every other effect with no blur, not an error. */
  dynamicAction: {
    lights: [
      {
        name: "key",
        lightType: "directional",
        transform: { position: [4, 5, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        intensity: 2.3,
        castShadow: true,
      },
      {
        name: "fill",
        lightType: "ambient",
        intensity: 0.4,
      },
    ],
    postProcessing: {
      effects: [
        { type: "motionBlur", shutterAngle: 200, samples: 16 },
        { type: "colorGrade", saturation: 1.15, contrast: 1.15 },
        { type: "sharpen", amount: 0.4 },
      ],
    },
  },
  /** A single hard, shadow-casting key light through haze plus a dim ambient fill: dramatic volumetric light shafts (`godRays`) with a cool, moody grade - built for a subject emerging from darkness, a product reveal through fog, or a window-light interior beat. `key`'s own `presetLightRef` is what `godRays.lightNodeId` below resolves against (see `LookPresetLight.presetLightRef`'s own doc); `godRays` itself silently no-ops if that light is ever missing/moved off directional-or-point/loses `castShadow` (see `GodRaysEffectConfig`'s own doc), so this preset degrades gracefully rather than breaking. */
  lightShafts: {
    lights: [
      {
        name: "key",
        presetLightRef: "key",
        lightType: "directional",
        transform: { position: [-4, 6, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
        intensity: 3,
        castShadow: true,
      },
      {
        name: "fill",
        lightType: "ambient",
        intensity: 0.15,
      },
    ],
    postProcessing: {
      effects: [
        { type: "godRays", lightNodeId: "key", density: 0.8, maxDensity: 0.6 },
        { type: "colorGrade", saturation: 0.85, contrast: 1.1, lift: [0.01, 0.015, 0.02] },
        { type: "vignette", darkness: 0.4, offset: 1.1 },
      ],
    },
  },
};

/**
 * The lighting rig `@cadra/renderer` falls back to when a composition's
 * resolved scene state has no authored `LightNode` and no `environment`
 * configured, so a bare mesh/model is never rendered fully unlit by
 * omission alone (Phase 73's own "cinematic defaults" deliverable: "a
 * minimal scene looks professional with defaults alone"). A three-point-
 * inspired key/fill/rim rig, matching `LOOK_PRESETS.cinematic`'s own light
 * data at the time this was authored - kept as its own separate constant
 * (not a live reference to `LOOK_PRESETS.cinematic`) so editing that named,
 * opt-in preset for its own sake never silently changes this always-on
 * engine-level fallback's own behavior. `castShadow` is deliberately never
 * set (defaults to no shadow casting): an invisible, automatic fallback
 * should not also invisibly allocate shadow-map GPU resources.
 */
export const DEFAULT_LIGHTING_RIG: readonly LookPresetLight[] = [
  {
    name: "key",
    lightType: "directional",
    transform: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
    intensity: 2.2,
  },
  {
    name: "fill",
    lightType: "ambient",
    intensity: 0.35,
  },
  {
    name: "rim",
    lightType: "point",
    transform: { position: [-3, 2, -4], rotation: [0, 0, 0], scale: [1, 1, 1] },
    color: [0.6, 0.7, 1, 1],
    intensity: 6,
  },
];

/** Thrown by `applyLookPreset` when `presetName` names no entry in `LOOK_PRESETS`. */
export class UnknownLookPresetError extends Error {
  constructor(presetName: string) {
    super(
      `applyLookPreset: no look preset named "${presetName}". Known presets: ${Object.keys(LOOK_PRESETS).join(", ")}.`,
    );
    this.name = "UnknownLookPresetError";
  }
}

/**
 * Thrown by `applyLookPreset` when a preset's own `godRays.lightNodeId`
 * names a `presetLightRef` none of that same preset's own lights declare -
 * a bug in `LOOK_PRESETS`' own static data (a typo, or a light renamed
 * without updating the effect that references it), never a user input
 * error: every `LOOK_PRESETS` entry is curated, checked-in data, not
 * something `apply_look_preset`'s own caller supplies. Thrown rather than
 * silently left unresolved specifically because an unresolved
 * `lightNodeId` would not fail loudly downstream either - `@cadra/renderer`'s
 * own `godRays` handling already treats a `lightNodeId` matching no real
 * light as a deliberate, silent no-op (see `GodRaysEffectConfig`'s own
 * doc), so this preset-authoring mistake needs its own explicit check to
 * ever surface at all.
 */
export class UnresolvedPresetLightRefError extends Error {
  constructor(presetName: string, lightNodeId: string) {
    super(
      `applyLookPreset: preset "${presetName}"'s own postProcessing references presetLightRef ` +
        `"${lightNodeId}", but none of its own lights declare that presetLightRef. This is a bug in ` +
        "LOOK_PRESETS' own static data, not a caller error.",
    );
    this.name = "UnresolvedPresetLightRefError";
  }
}

/**
 * Applies `presetName`'s lighting rig, post-processing, color grade, and
 * environment onto `composition`, returning a new `Composition` (never
 * mutating the input, matching every other pure scene-graph function in
 * this codebase). Each of the preset's own lights becomes its own new
 * `Track` (one `Light()` node spanning the composition's full
 * `durationInFrames`, matching every other single-node-per-track curated
 * scene pattern in this codebase); `postProcessing`/`colorGrading`/
 * `environment` (whichever the preset defines) overwrite the composition's
 * own existing values outright, the same "a preset is a starting point to
 * author from, not deep-merged with" convention `PBR_PRESETS`/
 * `POST_PROCESSING_LOOK_PRESETS` already document.
 *
 * Every `postProcessing` `godRays` effect's own `lightNodeId` is resolved
 * as a `presetLightRef` against this same preset's own `lights` (see
 * `LookPresetLight.presetLightRef`'s own doc) and substituted with that
 * light's real, freshly generated id before the result is returned - a
 * preset's static data can only ever reference its own light by that
 * preset-local key, since the real id does not exist until this function
 * actually runs. Every other effect type (and a `godRays.lightNodeId` that
 * happens to already look like a real id, e.g. hand-authored
 * `postProcessing` outside `LOOK_PRESETS` entirely) passes through
 * unchanged.
 *
 * `generateId` supplies every new track/clip/light-node id (typically
 * `createIdGenerator(seed)`, this codebase's own deterministic id source),
 * so applying the same preset to the same composition with the same seed
 * reproduces byte-identical output.
 *
 * @throws {UnknownLookPresetError} if `presetName` is not in `LOOK_PRESETS`.
 * @throws {UnresolvedPresetLightRefError} if a `godRays` effect's own
 *   `lightNodeId` names a `presetLightRef` this preset's own lights never
 *   declare.
 */
export function applyLookPreset(
  composition: Composition,
  presetName: string,
  generateId: () => string,
): Composition {
  const preset = LOOK_PRESETS[presetName];
  if (preset === undefined) {
    throw new UnknownLookPresetError(presetName);
  }

  const realIdByPresetLightRef = new Map<string, string>();
  const lightTracks: Track[] = preset.lights.map((light) => {
    const lightId = generateId();
    if (light.presetLightRef !== undefined) {
      realIdByPresetLightRef.set(light.presetLightRef, lightId);
    }
    const lightNode = Light({
      id: lightId,
      ...(light.name !== undefined && { name: light.name }),
      ...(light.transform !== undefined && { transform: light.transform }),
      ...(light.lightType !== undefined && { lightType: light.lightType }),
      ...(light.color !== undefined && { color: light.color }),
      ...(light.intensity !== undefined && { intensity: light.intensity }),
      ...(light.castShadow !== undefined && { castShadow: light.castShadow }),
    });
    const clip: Clip = Sequence({
      id: generateId(),
      from: 0,
      durationInFrames: composition.durationInFrames,
      content: lightNode,
    });
    return { id: generateId(), clips: [clip] };
  });

  const resolvedPostProcessing: CompositionPostProcessing | undefined =
    preset.postProcessing === undefined
      ? undefined
      : {
          ...preset.postProcessing,
          effects: preset.postProcessing.effects.map((effect) => {
            if (effect.type !== "godRays") {
              return effect;
            }
            const realLightId = realIdByPresetLightRef.get(effect.lightNodeId);
            if (realLightId === undefined) {
              throw new UnresolvedPresetLightRefError(presetName, effect.lightNodeId);
            }
            return { ...effect, lightNodeId: realLightId };
          }),
        };

  return {
    ...composition,
    tracks: [...composition.tracks, ...lightTracks],
    ...(resolvedPostProcessing !== undefined && { postProcessing: resolvedPostProcessing }),
    ...(preset.colorGrading !== undefined && { colorGrading: preset.colorGrading }),
    ...(preset.environment !== undefined && { environment: preset.environment }),
  };
}
