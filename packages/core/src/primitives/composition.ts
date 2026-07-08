import type {
  ActiveCameraEntry,
  AudioTrack,
  Composition as CompositionData,
  CompositionColorGrading,
  CompositionEnvironment,
  CompositionFog,
  CompositionPhysics,
  CompositionPostProcessing,
  CompositionRenderMode,
  CompositionShadowQuality,
  PathTracingConfig,
  PhysicsConstraintConfig,
  Track,
} from "../scene-graph/timeline.js";

/**
 * Props for `createComposition`. Named `createComposition` (matching the
 * existing `createProject` convention), not `Composition`, because that name
 * is already taken by the `Composition` data-shape type this factory
 * produces: TypeScript does not allow a value and a type re-exported from
 * separate modules to share a name at the same barrel, and `Composition` the
 * type has been part of the public API since Phase 2.
 *
 * `tracks` defaults to an empty array if omitted. `activeCameraTrack`,
 * `audioTracks`, `colorGrading`, `environment`, `fog`, `shadowQuality`,
 * `postProcessing`, `renderMode`, `pathTracing`, `physics`, and
 * `physicsConstraints` are all omitted (not defaulted to an empty
 * array/object) unless explicitly supplied, mirroring `Composition`'s own
 * "omitted means this composition has no active-camera concept/audio/color
 * grade/environment/fog/shadow tuning/post-processing/non-default render
 * mode/physics world at all" convention (see `../scene-graph/timeline.ts`)
 * rather than every composition gaining an empty-but-present lane it never
 * asked for.
 */
export interface CompositionProps {
  id: string;
  name: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  tracks?: Track[];
  activeCameraTrack?: ActiveCameraEntry[];
  audioTracks?: AudioTrack[];
  colorGrading?: CompositionColorGrading;
  environment?: CompositionEnvironment;
  fog?: CompositionFog;
  shadowQuality?: CompositionShadowQuality;
  postProcessing?: CompositionPostProcessing;
  renderMode?: CompositionRenderMode;
  pathTracing?: PathTracingConfig;
  physics?: CompositionPhysics;
  physicsConstraints?: PhysicsConstraintConfig[];
}

/**
 * Creates a `Composition`: a fixed frame rate, integer duration, output
 * size, and the tracks of clips that populate it.
 *
 * Defaults: `tracks: []`. `activeCameraTrack`/`audioTracks`/`colorGrading`/
 * `environment`/`fog`/`shadowQuality`/`postProcessing`/`renderMode`/`pathTracing`/
 * `physics`/`physicsConstraints` are passed through only when provided,
 * left `undefined` (not defaulted to `[]`) otherwise. Every other field is
 * required, since there is no sensible default frame rate, duration, or
 * output size for arbitrary authored content.
 */
export function createComposition(props: CompositionProps): CompositionData {
  return {
    id: props.id,
    name: props.name,
    fps: props.fps,
    durationInFrames: props.durationInFrames,
    width: props.width,
    height: props.height,
    tracks: props.tracks ?? [],
    ...(props.activeCameraTrack !== undefined && { activeCameraTrack: props.activeCameraTrack }),
    ...(props.audioTracks !== undefined && { audioTracks: props.audioTracks }),
    ...(props.colorGrading !== undefined && { colorGrading: props.colorGrading }),
    ...(props.environment !== undefined && { environment: props.environment }),
    ...(props.fog !== undefined && { fog: props.fog }),
    ...(props.shadowQuality !== undefined && { shadowQuality: props.shadowQuality }),
    ...(props.postProcessing !== undefined && { postProcessing: props.postProcessing }),
    ...(props.renderMode !== undefined && { renderMode: props.renderMode }),
    ...(props.pathTracing !== undefined && { pathTracing: props.pathTracing }),
    ...(props.physics !== undefined && { physics: props.physics }),
    ...(props.physicsConstraints !== undefined && { physicsConstraints: props.physicsConstraints }),
  };
}
