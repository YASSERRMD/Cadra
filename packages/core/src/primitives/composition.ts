import type { Composition as CompositionData, Track } from "../scene-graph/timeline.js";

/**
 * Props for `createComposition`. Named `createComposition` (matching the
 * existing `createProject` convention), not `Composition`, because that name
 * is already taken by the `Composition` data-shape type this factory
 * produces: TypeScript does not allow a value and a type re-exported from
 * separate modules to share a name at the same barrel, and `Composition` the
 * type has been part of the public API since Phase 2.
 *
 * `tracks` defaults to an empty array if omitted.
 */
export interface CompositionProps {
  id: string;
  name: string;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
  tracks?: Track[];
}

/**
 * Creates a `Composition`: a fixed frame rate, integer duration, output
 * size, and the tracks of clips that populate it.
 *
 * Defaults: `tracks: []`. Every other field is required, since there is no
 * sensible default frame rate, duration, or output size for arbitrary
 * authored content.
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
  };
}
