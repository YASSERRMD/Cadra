import type { AudioFadeEnvelope, Project } from "../scene-graph/timeline.js";
import { CompositionNotFoundError } from "../timeline-engine/errors.js";

/**
 * One flattened, plain-data audio segment: everything needed to identify and
 * later render one `AudioClip`'s contribution to a composition's mixdown.
 *
 * Deliberately carries no functions or closures (e.g. no embedded gain
 * callback): a later phase's audio encoder computes gain over time itself by
 * calling `computeGainAtLocalFrame` with the same `gain`/`fadeIn`/`fadeOut`
 * fields this segment already carries, rather than this description baking
 * in one specific evaluation strategy.
 */
export interface AudioMixdownSegment {
  trackId: string;
  clipId: string;
  assetRef: string;
  startFrame: number;
  durationInFrames: number;
  trimStartFrames: number;
  gain: number;
  fadeIn?: AudioFadeEnvelope;
  fadeOut?: AudioFadeEnvelope;
}

/**
 * A deterministic, flat description of every audio segment across every
 * `audioTrack` in one composition. See `resolveAudioMixdown`.
 */
export interface AudioMixdownDescription {
  compositionId: string;
  segments: AudioMixdownSegment[];
}

/**
 * Resolves `project`'s composition `compositionId` into a flat, plain-data
 * `AudioMixdownDescription`: one `AudioMixdownSegment` per `AudioClip` across
 * every `AudioTrack` on that composition, in track/clip authoring order.
 *
 * Pure and independent of real time or preview state: this function reads
 * only `project` (no wall clock, no Web Audio, no transport/playback
 * position), so calling it twice for the same `(project, compositionId)`
 * always returns a deep-equal result, regardless of when or how many times
 * it is called, and regardless of anything a live preview happens to be
 * doing concurrently. Unlike `resolveSceneAtFrame`, this takes no `frame`
 * argument at all: a mixdown describes the composition's entire audio
 * timeline at once, not one instant of it, since a later encoder needs the
 * full picture to render a continuous audio track rather than one frame's
 * sample.
 *
 * A composition with no `audioTracks` (or an empty one) resolves to an empty
 * `segments` array, matching every composition authored before Phase 16.
 *
 * @throws {CompositionNotFoundError} if `compositionId` does not exist in `project`.
 */
export function resolveAudioMixdown(project: Project, compositionId: string): AudioMixdownDescription {
  const composition = project.compositions.find((candidate) => candidate.id === compositionId);
  if (composition === undefined) {
    throw new CompositionNotFoundError(compositionId);
  }

  const segments: AudioMixdownSegment[] = [];
  for (const track of composition.audioTracks ?? []) {
    for (const clip of track.clips) {
      segments.push({
        trackId: track.id,
        clipId: clip.id,
        assetRef: clip.assetRef,
        startFrame: clip.startFrame,
        durationInFrames: clip.durationInFrames,
        trimStartFrames: clip.trimStartFrames ?? 0,
        gain: clip.gain ?? 1,
        ...(clip.fadeIn !== undefined && { fadeIn: clip.fadeIn }),
        ...(clip.fadeOut !== undefined && { fadeOut: clip.fadeOut }),
      });
    }
  }

  return { compositionId, segments };
}
