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
 * A small, deliberately starter set of look presets (Phase 72's own scope:
 * ship the mechanism and prove it works end to end). Phase 73 is where this
 * codebase's own improvement track ships the full curated library ("product,
 * documentary, bold social, elegant title" per that phase's own task list) -
 * adding a new named entry here later is a pure data addition, no mechanism
 * change.
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
};

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
