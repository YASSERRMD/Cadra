import type { Property } from "../keyframes/keyframe-track.js";
import { type AnimatableTransform, createIdentityTransform } from "../scene-graph/primitives.js";
import type {
  VideoBlendMode,
  VideoFitMode,
  VideoNode,
  VideoOutOfRangeBehavior,
} from "../scene-graph/scene-node.js";

/**
 * Props for `Video`. Only `id` is required; everything else defaults.
 *
 * `transform`, `visible`, and `opacity` each accept either a plain value or
 * a `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain value, as
 * every existing primitive's caller does, keeps working unchanged.
 *
 * `blendMode`/`maskRef` (Phase 36) mirror `VideoNode.blendMode`/
 * `VideoNode.maskRef` exactly; see those fields' own doc comments.
 */
export interface VideoProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: VideoNode["children"];
  assetRef?: string;
  blendMode?: VideoBlendMode;
  maskRef?: string;
  inFrame?: number;
  outFrame?: number;
  playbackRate?: number;
  fitMode?: VideoFitMode;
  outOfRangeBehavior?: VideoOutOfRangeBehavior;
  opacity?: Property<number>;
}

/**
 * Creates a `VideoNode`: an external video file placed as a layer.
 *
 * Defaults: identity transform, `visible: true`, no children,
 * `assetRef: "default"`, no `blendMode` (renders as `'normal'`), no
 * `maskRef` (unmasked), `inFrame`/`outFrame` omitted (play the whole
 * source), `playbackRate: 1`, `fitMode: "cover"`,
 * `outOfRangeBehavior: "hold"`, `opacity: 1`.
 */
export function Video(props: VideoProps): VideoNode {
  return {
    id: props.id,
    kind: "video",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    assetRef: props.assetRef ?? "default",
    ...(props.blendMode !== undefined && { blendMode: props.blendMode }),
    ...(props.maskRef !== undefined && { maskRef: props.maskRef }),
    ...(props.inFrame !== undefined && { inFrame: props.inFrame }),
    ...(props.outFrame !== undefined && { outFrame: props.outFrame }),
    ...(props.playbackRate !== undefined && { playbackRate: props.playbackRate }),
    ...(props.fitMode !== undefined && { fitMode: props.fitMode }),
    ...(props.outOfRangeBehavior !== undefined && {
      outOfRangeBehavior: props.outOfRangeBehavior,
    }),
    opacity: props.opacity ?? 1,
  };
}

/**
 * Input to `resolveVideoSourceFrame`: the `VideoNode` fields its mapping
 * actually reads. A plain, standalone object (rather than the full
 * `VideoNode`) so the timeline engine, or a test, can call this without
 * constructing an entire node.
 */
export interface VideoFrameMapping {
  inFrame?: number;
  outFrame?: number;
  playbackRate?: number;
  outOfRangeBehavior?: VideoOutOfRangeBehavior;
}

/**
 * Maps a clip-local frame (frames since the containing `Clip`'s own
 * `startFrame`, i.e. exactly the `localFrame` shape `resolveSequenceFrame`
 * produces) to the exact source-video-local frame number to sample,
 * entirely independent of whether this clip is currently visible: the
 * surrounding timeline machinery already decides that separately (see
 * `resolveSequenceFrame`).
 *
 * Trim range: `[inFrame ?? 0, outFrame ?? Infinity]`, both ends inclusive.
 * `outFrame: undefined` means "play to the source's own natural end", which
 * this function models as an unbounded range (there is nothing to hold or
 * loop against without knowing the source's real duration; a caller with
 * that duration in hand can pass it as `outFrame` to get bounded behavior).
 *
 * Playback rate: `sourceFrame = inFrame + floor(localFrame * playbackRate)`
 * for any `localFrame` that keeps `sourceFrame` inside the trim range.
 * `playbackRate` scales how fast the source advances relative to
 * clip/composition time: `2` consumes the trimmed range in half the
 * `localFrame` span it would at `1`, `0.5` takes twice as long. This is
 * exact at every boundary: `localFrame === 0` always maps to precisely
 * `inFrame` (or `0`), never one frame off in either direction, since
 * `floor(0 * playbackRate) === 0` for every `playbackRate`.
 *
 * Negative `localFrame` (this node's containing clip has not started yet,
 * by this function's own frame-relative accounting) maps below `inFrame`
 * using the same formula, unclamped: this mirrors `resolveSequenceFrame`'s
 * own choice to keep `localFrame` continuous and well-defined outside its
 * visible window rather than clamping, so a caller inspecting frames just
 * before a clip starts still gets a meaningful, deterministic answer.
 *
 * Out of range (raw `sourceFrame` computed above lands past `outFrame`,
 * i.e. the source is shorter than however long this node ends up
 * placed/visible for): resolved per `mapping.outOfRangeBehavior` (defaults
 * to `'hold'`).
 * - `'hold'`: clamps to `outFrame` exactly, for every `localFrame` whose raw
 *   mapping would otherwise exceed it.
 * - `'loop'`: wraps the raw `sourceFrame` back into the trim range via
 *   modulo arithmetic on the range's own length, so it continues advancing
 *   (rather than freezing) once it wraps.
 *
 * Both behaviors require a finite `outFrame` to have anything to hold at or
 * loop within; with `outFrame` omitted (unbounded range), `sourceFrame` is
 * simply never past range, so `outOfRangeBehavior` is never consulted.
 */
export function resolveVideoSourceFrame(mapping: VideoFrameMapping, localFrame: number): number {
  const inFrame = mapping.inFrame ?? 0;
  const playbackRate = mapping.playbackRate ?? 1;
  const rawSourceFrame = inFrame + Math.floor(localFrame * playbackRate);

  if (mapping.outFrame === undefined || rawSourceFrame <= mapping.outFrame) {
    return rawSourceFrame;
  }

  // rawSourceFrame is past the trimmed range's natural end.
  const outFrame = mapping.outFrame;
  const behavior = mapping.outOfRangeBehavior ?? "hold";
  if (behavior === "hold") {
    return outFrame;
  }

  // 'loop': wrap back into [inFrame, outFrame] by how far rawSourceFrame
  // overshot inFrame, modulo the trim range's own length (in source frames).
  const rangeLength = outFrame - inFrame + 1;
  const framesSinceInFrame = rawSourceFrame - inFrame;
  return inFrame + (framesSinceInFrame % rangeLength);
}
