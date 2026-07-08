/**
 * Shared "resolve a target track, then insert a new clip onto it" logic:
 * originally written for `add_generated_clip` (`./generation-clip-tools.ts`),
 * extracted here once a second tool (`add_text_node`, `./text-node-tools.ts`)
 * needed the exact same "existing track by id, or a brand-new one to
 * create" selector and insertion semantics. Small single-tool helpers in
 * this package are deliberately duplicated per file rather than shared (see
 * `generation-clip-tools.ts`'s own `singleDiagnosticFailure`), but this is
 * substantial enough (composition/track lookup, id-collision checks, new
 * v. existing branching) that duplicating it risks the two copies silently
 * drifting apart instead.
 */
import type { Clip, Project, Track } from "@cadra/core";
import { DIAGNOSTIC_CODES, type SceneParseDiagnostic } from "@cadra/schema";
import { z } from "zod";

/** A `{ success: false, diagnostics }` failure payload, matching every write tool in this package's own failure shape. */
export interface TrackInsertionFailurePayload {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

/** Builds a single-diagnostic {@link TrackInsertionFailurePayload}. */
export function singleDiagnosticFailure(
  path: string,
  message: string,
  code: string,
  suggestedFix?: string,
): TrackInsertionFailurePayload {
  return {
    success: false,
    diagnostics: [{ path, message, code, ...(suggestedFix !== undefined ? { suggestedFix } : {}) }],
  };
}

/** Zod shape for the target-track selector: an existing track by id, or a brand-new one to create. */
export const trackSelectorShape = {
  existingTrackId: z
    .string()
    .optional()
    .describe("Id of an existing track (within the named composition) to append the new clip onto."),
  newTrackId: z
    .string()
    .optional()
    .describe("Id for a brand-new track to create (and append the new clip onto). Must not already exist."),
  newTrackName: z
    .string()
    .optional()
    .describe("Optional human-readable name for the new track. Only used together with newTrackId."),
};

/** Resolves `input`'s track selector against `composition`'s existing tracks: returns the resolved track id plus whether it needs to be freshly created, or a ready-to-return failure payload. `newTrackName` (if a new track is being created) is applied later by `insertClipOntoTrack`, not by this purely-resolving function. */
export function resolveTrackSelector(
  composition: { id: string; tracks: readonly Track[] },
  existingTrackId: string | undefined,
  newTrackId: string | undefined,
): { ok: true; trackId: string; createNew: boolean } | { ok: false; failure: TrackInsertionFailurePayload } {
  if ((existingTrackId === undefined) === (newTrackId === undefined)) {
    return {
      ok: false,
      failure: singleDiagnosticFailure(
        "track",
        "requires exactly one of existingTrackId or newTrackId, not both or neither.",
        DIAGNOSTIC_CODES.MISSING_REQUIRED_FIELD,
      ),
    };
  }

  if (existingTrackId !== undefined) {
    const found = composition.tracks.find((track) => track.id === existingTrackId);
    if (found === undefined) {
      const availableIds = composition.tracks.map((track) => track.id);
      return {
        ok: false,
        failure: singleDiagnosticFailure(
          "existingTrackId",
          `Composition "${composition.id}" has no track with id "${existingTrackId}". Available track ` +
            `ids: ${availableIds.length > 0 ? availableIds.join(", ") : "(none)"}.`,
          "TRACK_NOT_FOUND",
        ),
      };
    }
    return { ok: true, trackId: existingTrackId, createNew: false };
  }

  const collision = composition.tracks.find((track) => track.id === newTrackId);
  if (collision !== undefined) {
    return {
      ok: false,
      failure: singleDiagnosticFailure(
        "newTrackId",
        `Composition "${composition.id}" already has a track with id "${newTrackId}". Choose a ` +
          "different id, or pass it as existingTrackId instead.",
        "DUPLICATE_TRACK_ID",
      ),
    };
  }

  return { ok: true, trackId: newTrackId as string, createNew: true };
}

/**
 * Inserts `clip` onto the track named `trackId` within `compositionId` of
 * `project`, creating that track fresh (named `newTrackName`, if given) if
 * `createNew` is `true`, or appending onto its existing `clips` array
 * otherwise. Returns a new `Project`, structurally sharing every
 * composition/track this call did not touch (mirroring `scene-patch.ts`'s
 * own `applyNodeOperationToProject` sharing discipline).
 */
export function insertClipOntoTrack(
  project: Project,
  compositionId: string,
  trackId: string,
  createNew: boolean,
  newTrackName: string | undefined,
  clip: Clip,
): Project {
  return {
    ...project,
    compositions: project.compositions.map((composition) => {
      if (composition.id !== compositionId) {
        return composition;
      }

      if (createNew) {
        const newTrack: Track = {
          id: trackId,
          ...(newTrackName !== undefined ? { name: newTrackName } : {}),
          clips: [clip],
        };
        return { ...composition, tracks: [...composition.tracks, newTrack] };
      }

      return {
        ...composition,
        tracks: composition.tracks.map((track) =>
          track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
        ),
      };
    }),
  };
}
