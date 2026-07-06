import type {
  ActiveCameraEntry,
  AudioTrack,
  Composition as CompositionData,
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
 * `tracks` defaults to an empty array if omitted. `activeCameraTrack` and
 * `audioTracks` are both omitted (not defaulted to an empty array) unless
 * explicitly supplied, mirroring `Composition`'s own "omitted means this
 * composition has no active-camera concept/audio at all" convention (see
 * `../scene-graph/timeline.ts`) rather than every composition gaining an
 * empty-but-present lane it never asked for.
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
}

/**
 * Creates a `Composition`: a fixed frame rate, integer duration, output
 * size, and the tracks of clips that populate it.
 *
 * Defaults: `tracks: []`. `activeCameraTrack`/`audioTracks` are passed
 * through only when provided, left `undefined` (not defaulted to `[]`)
 * otherwise. Every other field is required, since there is no sensible
 * default frame rate, duration, or output size for arbitrary authored
 * content.
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
  };
}
