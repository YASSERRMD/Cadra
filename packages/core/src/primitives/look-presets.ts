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
 * `postProcessing.effects` JSON). Adding a new named entry here later is a
 * pure data addition, no mechanism change - with one caveat: `godRays`
 * (`GodRaysEffectConfig`) needs a `lightNodeId` referencing a specific
 * `LightNode`'s id, but a preset's own lights only ever get a fresh id at
 * `applyLookPreset`'s own call time (`generateId()`, below) - there is no
 * mechanism today for a preset's static `postProcessing` to reference one
 * of its own not-yet-generated light ids, so `godRays` cannot be added to
 * a preset without a real design change first (tracked separately).
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
 * `generateId` supplies every new track/clip/light-node id (typically
 * `createIdGenerator(seed)`, this codebase's own deterministic id source),
 * so applying the same preset to the same composition with the same seed
 * reproduces byte-identical output.
 *
 * @throws {UnknownLookPresetError} if `presetName` is not in `LOOK_PRESETS`.
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

  const lightTracks: Track[] = preset.lights.map((light) => {
    const lightNode = Light({
      id: generateId(),
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

  return {
    ...composition,
    tracks: [...composition.tracks, ...lightTracks],
    ...(preset.postProcessing !== undefined && { postProcessing: preset.postProcessing }),
    ...(preset.colorGrading !== undefined && { colorGrading: preset.colorGrading }),
    ...(preset.environment !== undefined && { environment: preset.environment }),
  };
}
