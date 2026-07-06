import {
  type ActiveCameraEntry,
  type AudioTrack,
  type Clip,
  type Composition,
  createComposition,
  type Track,
} from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";

import { SceneBuilderUsageError } from "./errors.js";
import type { ClipPlacement } from "./node-builder.js";

/**
 * The id of the single track `CompositionBuilder.add()` places clips on when
 * a caller never explicitly names a track via `.track()`. Deterministic and
 * fixed, not generated, matching the rest of this framework's convention of
 * never inventing an id the caller did not ask for (see
 * `deriveSequenceRootId` in `@cadra/core` for the same principle applied to
 * `Sequence`'s wrapper node).
 */
const DEFAULT_TRACK_ID = "track-1";

/** Anything `CompositionBuilder.add()` accepts: a placed `NodeBuilder` (`.at()`'s result), or a bare `Clip`. */
export type Addable = ClipPlacement | Clip;

function toClip(addable: Addable): Clip {
  return "clip" in addable ? addable.clip : addable;
}

/**
 * Fluent builder for a single `Composition`: add clips (directly, or via
 * named tracks), and optionally set the active-camera lane, before handing
 * the assembled `Composition` back to the parent `SceneBuilder`.
 *
 * Returned by `SceneBuilder.composition()`, which passes its own `.build()`
 * in as `onBuild` (a plain callback, not a class reference, to avoid a
 * circular import between this module and `scene-builder.ts`): calling
 * `.build()` on a `CompositionBuilder` delegates straight back to the
 * `SceneBuilder` that created it, so the full
 * `scene({...}).composition({...}).add(...).build()` chain works without an
 * extra step to hop back to the original `scene(...)` reference. Every
 * `CompositionBuilder` produced by the same `SceneBuilder` shares the same
 * `onBuild`, so calling `.build()` from any one of them assembles the
 * *entire* project (every composition added so far), not just the one
 * `CompositionBuilder` it was called on.
 */
export class CompositionBuilder {
  private readonly id: string;
  private readonly name: string;
  private readonly fps: number;
  private readonly durationInFrames: number;
  private readonly width: number;
  private readonly height: number;
  private readonly tracks = new Map<string, Track>();
  private activeCameraTrack: ActiveCameraEntry[] | undefined;
  private audioTracks: AudioTrack[] | undefined;
  private readonly onBuild: () => SceneDocument;

  constructor(props: CompositionBuilderProps, onBuild: () => SceneDocument) {
    const size = resolveSize(props);
    this.id = props.id;
    this.name = props.name;
    this.fps = props.fps;
    this.durationInFrames = props.durationInFrames;
    this.width = size.width;
    this.height = size.height;
    this.onBuild = onBuild;
  }

  /**
   * Adds a clip to this composition. Without `trackId`, every call goes onto
   * a single implicit default track (see `DEFAULT_TRACK_ID`); pass `trackId`
   * (creating the track on first use, matching `.track()`'s own
   * get-or-create behavior) to place clips on separate, independently
   * ordered tracks instead.
   *
   * Accepts either a `NodeBuilder.at()` placement or a bare `Clip` (e.g. from
   * `Sequence`/`Series`, which already produce `Clip`/`Clip[]` directly, no
   * `.at()` needed), so builder-authored and `Sequence`/`Series`-authored
   * content compose on the same timeline without a caller having to convert
   * between shapes.
   */
  add(addable: Addable, trackId: string = DEFAULT_TRACK_ID): this {
    const track = this.getOrCreateTrack(trackId);
    track.clips.push(toClip(addable));
    return this;
  }

  /**
   * Adds every clip in `addables`, in order, to the same track. A thin
   * convenience over repeated `.add()` calls for `Series`' `Clip[]` output,
   * or any other batch of already-placed clips.
   */
  addAll(addables: ReadonlyArray<Addable>, trackId: string = DEFAULT_TRACK_ID): this {
    for (const addable of addables) {
      this.add(addable, trackId);
    }
    return this;
  }

  /**
   * Gets (creating if this is the first reference to `trackId`) the `Track`
   * with this id, so a caller can name tracks explicitly for readability
   * (e.g. `"camera-track"`, `"titles-track"`) rather than relying on the
   * single implicit default track every unqualified `.add()` call uses.
   * `name` is only applied the first time a given `trackId` is seen; passing
   * a different `name` for an already-created track has no effect, since a
   * `Track`'s `name` is set once at creation.
   */
  track(trackId: string, name?: string): this {
    this.getOrCreateTrack(trackId, name);
    return this;
  }

  /**
   * Sets (replacing any previously set) the active-camera lane: which
   * `CameraNode` (by id) is active for each window of frames, independent of
   * which tracks carry renderable content. Mirrors `Composition.activeCameraTrack`.
   */
  setActiveCameraTrack(entries: ActiveCameraEntry[]): this {
    this.activeCameraTrack = entries;
    return this;
  }

  /** Sets (replacing any previously set) this composition's audio tracks. Mirrors `Composition.audioTracks`. */
  setAudioTracks(tracks: AudioTrack[]): this {
    this.audioTracks = tracks;
    return this;
  }

  /**
   * Assembles the final `Composition` this builder describes, via
   * `@cadra/core`'s own `createComposition` factory (so defaults/shape stay
   * in exact sync with it). Called by the parent `SceneBuilder`, not
   * typically by application code directly.
   */
  toComposition(): Composition {
    return createComposition({
      id: this.id,
      name: this.name,
      fps: this.fps,
      durationInFrames: this.durationInFrames,
      width: this.width,
      height: this.height,
      tracks: [...this.tracks.values()],
      ...(this.activeCameraTrack !== undefined && { activeCameraTrack: this.activeCameraTrack }),
      ...(this.audioTracks !== undefined && { audioTracks: this.audioTracks }),
    });
  }

  /**
   * Terminal method: assembles every composition the parent `SceneBuilder`
   * has produced so far (not just this one) into a `Project`, wraps it in
   * the scene document envelope, and validates it through `parseScene`,
   * exactly as `SceneBuilder.build()` does (this delegates straight to it
   * via the `onBuild` callback passed in at construction). Lets a full
   * authoring chain read start to finish without hopping back to the
   * original `scene(...)` reference:
   * `scene({...}).composition({...}).add(...).build()`.
   */
  build(): SceneDocument {
    return this.onBuild();
  }

  private getOrCreateTrack(trackId: string, name?: string): Track {
    const existing = this.tracks.get(trackId);
    if (existing !== undefined) {
      return existing;
    }
    const track: Track = { id: trackId, ...(name !== undefined && { name }), clips: [] };
    this.tracks.set(trackId, track);
    return track;
  }
}

/** The output pixel dimensions of a composition, as a single grouped value. */
export interface CompositionSize {
  width: number;
  height: number;
}

/**
 * Props `SceneBuilder.composition()` takes to start a new `CompositionBuilder`.
 *
 * Accepts the output size either as a grouped `size: { width, height }`
 * (matching this phase's spec's illustrative
 * `scene().composition({ fps, size })` chaining shape) or as flat
 * `width`/`height` fields (matching `@cadra/core`'s actual `CompositionProps`
 * exactly). Exactly one of the two forms must be given; providing both, or
 * neither, throws `SceneBuilderUsageError` immediately in the constructor,
 * since there is no sensible way to reconcile two different size sources
 * silently.
 */
export type CompositionBuilderProps =
  | { id: string; name: string; fps: number; durationInFrames: number; size: CompositionSize }
  | {
      id: string;
      name: string;
      fps: number;
      durationInFrames: number;
      width: number;
      height: number;
    };

function resolveSize(props: CompositionBuilderProps): CompositionSize {
  const hasSize = "size" in props;
  const hasWidth = "width" in props;
  const hasHeight = "height" in props;

  if (hasSize && (hasWidth || hasHeight)) {
    throw new SceneBuilderUsageError(
      "composition(): pass either 'size: { width, height }' or flat 'width'/'height', not both.",
    );
  }
  if (hasSize) {
    // "size" in props only proves the key is present, not that its value is
    // a real CompositionSize: a caller that bypasses the CompositionBuilderProps
    // union type (e.g. an agent assembling props dynamically, or a plain `as never`
    // cast, as this file's own tests do) could still pass `size: undefined`. Guard
    // explicitly so that case fails fast and specifically here, matching every
    // other undefined-handling path in this file, rather than silently producing
    // a Composition with width/height both undefined that only surfaces as an
    // opaque SceneBuildError far later, out of .build().
    if (props.size === undefined || props.size === null) {
      throw new SceneBuilderUsageError(
        `composition(): 'size' was provided but is ${String(props.size)}, not a { width, height } object.`,
      );
    }
    return props.size;
  }
  if (hasWidth && hasHeight) {
    return { width: props.width, height: props.height };
  }
  if (hasWidth || hasHeight) {
    throw new SceneBuilderUsageError(
      "composition(): got only one of 'width'/'height'. Pass both, or use 'size: { width, height }'.",
    );
  }
  throw new SceneBuilderUsageError(
    "composition(): missing an output size. Pass 'size: { width, height }' or flat 'width'/'height'.",
  );
}
