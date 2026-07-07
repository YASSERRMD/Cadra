import type { Clip, Composition, Track } from "./timeline.js";

/** Thrown when a clip operation is given a track or clip id that does not exist in the given `Composition`. */
export class ClipNotFoundError extends Error {
  constructor(trackId: string, clipId: string | undefined, operation: string) {
    super(
      clipId === undefined
        ? `${operation}: no track with id "${trackId}" was found in the composition.`
        : `${operation}: no clip with id "${clipId}" was found on track "${trackId}".`,
    );
    this.name = "ClipNotFoundError";
  }
}

/** The subset of `Clip` fields `updateClipTiming` may change: its position and length on the timeline. */
export interface ClipTimingUpdate {
  startFrame?: number;
  durationInFrames?: number;
}

/**
 * Returns a new `Composition` equal to `composition` except that the clip
 * identified by `trackId`/`clipId` has `update`'s fields applied to it (any
 * field `update` omits is left unchanged on the clip).
 *
 * This is the `Track`/`Clip`-level counterpart to `tree-operations.ts`'s
 * `updateNode`: `tree-operations.ts` operates one level down (the
 * `SceneNode` subtree a `Clip.node` points at), not on the `Clip` itself, so
 * moving or trimming a clip's position on its track needs this sibling
 * helper instead.
 *
 * Immutable and uses structural sharing: only `composition.tracks`, the one
 * matched `Track`, its `clips` array, and the one matched `Clip` are newly
 * allocated; every other track and every other clip on the matched track
 * keep their exact original object references. `composition` is never
 * mutated.
 *
 * Deliberately does not clamp or validate `update` beyond copying it onto
 * the clip (e.g. it will happily produce a negative `startFrame` or a
 * non-positive `durationInFrames` if asked to): this module has no schema
 * dependency of its own, matching how `tree-operations.ts` also performs no
 * validation of the `SceneNode` shapes it copies. Producing (and rejecting,
 * if invalid) a fully validated document is `@cadra/schema`'s `parseScene`
 * job, run by the studio app's `commitDocument` funnel after calling this;
 * a caller that wants to guarantee only ever calling this with an
 * already-valid result (e.g. to avoid a wasted `commitDocument` round trip)
 * should clamp its own drag/trim math before constructing `update`, exactly
 * as `apps/studio`'s timeline drag math does.
 *
 * @throws {ClipNotFoundError} if no track with id `trackId` exists in
 *   `composition.tracks`, or no clip with id `clipId` exists on that track.
 */
export function updateClipTiming(
  composition: Composition,
  trackId: string,
  clipId: string,
  update: ClipTimingUpdate,
): Composition {
  const trackIndex = composition.tracks.findIndex((track) => track.id === trackId);
  if (trackIndex === -1) {
    throw new ClipNotFoundError(trackId, undefined, "updateClipTiming");
  }
  const track = composition.tracks[trackIndex] as Track;

  const clipIndex = track.clips.findIndex((clip) => clip.id === clipId);
  if (clipIndex === -1) {
    throw new ClipNotFoundError(trackId, clipId, "updateClipTiming");
  }
  const clip = track.clips[clipIndex] as Clip;

  const nextClip: Clip = { ...clip, ...update };
  const nextClips = [...track.clips];
  nextClips[clipIndex] = nextClip;
  const nextTrack: Track = { ...track, clips: nextClips };
  const nextTracks = [...composition.tracks];
  nextTracks[trackIndex] = nextTrack;

  return { ...composition, tracks: nextTracks };
}

/**
 * Returns a new `Composition` equal to `composition` except that the clip
 * identified by `sourceTrackId`/`clipId` has been removed from its source
 * track and appended to `targetTrackId`'s clips, with `update`'s fields (if
 * any) applied to it.
 *
 * Used for dragging a clip from one track onto another (a cross-track move,
 * as distinct from `updateClipTiming`'s same-track reposition/trim).
 * `targetTrackId` may be the same as `sourceTrackId`; in that case the clip
 * is removed and re-appended to the end of the same track's `clips` array
 * (changing its position in that array, not just its `startFrame`), which is
 * how this helper also supports the "reorder within a track" gesture the
 * pixel/frame math on its own has no notion of (array order versus
 * `startFrame` order are independent: this codebase's `Track.clips` is
 * documented as "an ordered lane of non-overlapping-by-convention clips",
 * but nothing enforces that array order matches `startFrame` order, so
 * moving a clip either earlier or later among its siblings by array position
 * is a distinct, legitimate edit from just changing its `startFrame`).
 *
 * Same immutability/structural-sharing and non-validating posture as
 * `updateClipTiming`; see that function's own doc.
 *
 * @throws {ClipNotFoundError} if no track with id `sourceTrackId` or
 *   `targetTrackId` exists in `composition.tracks`, or no clip with id
 *   `clipId` exists on the source track.
 */
export function moveClipToTrack(
  composition: Composition,
  sourceTrackId: string,
  clipId: string,
  targetTrackId: string,
  update: ClipTimingUpdate = {},
): Composition {
  const sourceTrackIndex = composition.tracks.findIndex((track) => track.id === sourceTrackId);
  if (sourceTrackIndex === -1) {
    throw new ClipNotFoundError(sourceTrackId, undefined, "moveClipToTrack");
  }
  const sourceTrack = composition.tracks[sourceTrackIndex] as Track;

  const clipIndex = sourceTrack.clips.findIndex((clip) => clip.id === clipId);
  if (clipIndex === -1) {
    throw new ClipNotFoundError(sourceTrackId, clipId, "moveClipToTrack");
  }
  const clip = sourceTrack.clips[clipIndex] as Clip;
  const movedClip: Clip = { ...clip, ...update };

  if (sourceTrackId === targetTrackId) {
    const nextClips = sourceTrack.clips.filter((candidate) => candidate.id !== clipId);
    nextClips.push(movedClip);
    const nextTrack: Track = { ...sourceTrack, clips: nextClips };
    const nextTracks = [...composition.tracks];
    nextTracks[sourceTrackIndex] = nextTrack;
    return { ...composition, tracks: nextTracks };
  }

  const targetTrackIndex = composition.tracks.findIndex((track) => track.id === targetTrackId);
  if (targetTrackIndex === -1) {
    throw new ClipNotFoundError(targetTrackId, undefined, "moveClipToTrack");
  }
  const targetTrack = composition.tracks[targetTrackIndex] as Track;

  const nextSourceClips = sourceTrack.clips.filter((candidate) => candidate.id !== clipId);
  const nextSourceTrack: Track = { ...sourceTrack, clips: nextSourceClips };
  const nextTargetTrack: Track = { ...targetTrack, clips: [...targetTrack.clips, movedClip] };

  const nextTracks = [...composition.tracks];
  nextTracks[sourceTrackIndex] = nextSourceTrack;
  nextTracks[targetTrackIndex] = nextTargetTrack;

  return { ...composition, tracks: nextTracks };
}
