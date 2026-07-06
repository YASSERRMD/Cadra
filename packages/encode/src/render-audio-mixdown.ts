import type { AudioClip, AudioMixdownDescription, AudioMixdownSegment } from "@cadra/core";
import { computeGainAtLocalFrame, frameToTime } from "@cadra/core";

import {
  type AudioBufferLike,
  createDefaultOfflineAudioContextLike,
  type DefaultOfflineAudioContextOptions,
  type OfflineAudioContextLike,
  type OfflineGainNodeLike,
} from "./offline-audio-context-like.js";

/**
 * Resolves `assetRef` (an `AudioMixdownSegment.assetRef`) to its decoded
 * `AudioBufferLike`, or `undefined` if it is not loaded (yet, or ever).
 * Mirrors `@cadra/player`'s `ResolveAudioBufferFn` (`attach-audio.ts`), but
 * this package owns no live playback/`Transport`, so this is a standalone
 * type rather than a re-export: this package does not own audio decoding
 * either way, and a caller wiring up a real render (e.g. Phase 23's
 * headless-Chromium server render path) supplies whatever asset pipeline it
 * already has behind this same synchronous shape.
 */
export type ResolveAudioBufferFn = (assetRef: string) => AudioBufferLike | undefined;

/** Options accepted by `renderAudioMixdown`. */
export interface RenderAudioMixdownOptions {
  /** The mixdown description to render, i.e. `resolveAudioMixdown`'s output. */
  mixdown: AudioMixdownDescription;
  /** Frame rate of the composition the mixdown was resolved from. */
  fps: number;
  /**
   * Total frame count of the composition the mixdown was resolved from.
   * Required (not derived from the mixdown's own segments): the render must
   * span the full composition, not just the range covered by audio content,
   * so a mixdown whose first clip starts after frame 0 still produces a
   * buffer aligned to frame 0, and one whose last clip ends before the
   * composition's own end still produces a buffer of the full length.
   */
  durationInFrames: number;
  /** Looks up a decoded `AudioBufferLike` for a segment's `assetRef`. */
  resolveAudioBuffer: ResolveAudioBufferFn;
  /** Sample rate to render at, in Hz. Defaults to `DEFAULT_RENDER_SAMPLE_RATE`. */
  sampleRate?: number;
  /** Number of channels to render. Defaults to `DEFAULT_RENDER_CHANNEL_COUNT`. */
  numberOfChannels?: number;
  /**
   * `OfflineAudioContextLike` to render with, defaulting to a real
   * `OfflineAudioContext` (via `createDefaultOfflineAudioContextLike`) sized
   * to exactly cover `durationInFrames / fps` seconds. Injectable so tests
   * can supply a fake that records scheduled nodes and returns a
   * deterministic fake `AudioBufferLike` from `startRendering()`, without a
   * real Web Audio-capable environment.
   */
  offlineAudioContext?: OfflineAudioContextLike;
}

/**
 * Default render sample rate: 48,000 Hz, the standard rate both AAC and
 * Opus encode at without resampling (see `encode-audio.ts`'s own doc for why
 * this matters at the encoding stage), and the most common default a real
 * `OfflineAudioContext` itself would pick.
 */
export const DEFAULT_RENDER_SAMPLE_RATE = 48_000;

/**
 * Default render channel count: stereo, matching the common case for a
 * composition's audio mixdown (mono source clips still render correctly
 * into a stereo buffer, since a real `AudioBufferSourceNode` up/down-mixes
 * automatically).
 */
export const DEFAULT_RENDER_CHANNEL_COUNT = 2;

/** Frames-per-second conversion helper: `frames / fps` seconds, never negative. Mirrors `@cadra/player`'s `attach-audio.ts`. */
function framesToSeconds(frames: number, fps: number): number {
  return Math.max(frames, 0) / fps;
}

/**
 * Adapts one `AudioMixdownSegment` into a real `AudioClip` so
 * `computeGainAtLocalFrame` (which requires a real `AudioClip`; see this
 * phase's own spec for why `gain-envelope.ts`'s existing signature is not
 * modified) can be reused unchanged: `AudioMixdownSegment` is structurally
 * close to but not identical to `AudioClip` (a segment carries `clipId`
 * instead of `id`, and no `id` field at all), so this spreads the segment's
 * fields alongside a synthesized `id` taken from `clipId`.
 */
function segmentToAudioClip(segment: AudioMixdownSegment): AudioClip {
  return {
    id: segment.clipId,
    startFrame: segment.startFrame,
    durationInFrames: segment.durationInFrames,
    assetRef: segment.assetRef,
    trimStartFrames: segment.trimStartFrames,
    gain: segment.gain,
    ...(segment.fadeIn !== undefined && { fadeIn: segment.fadeIn }),
    ...(segment.fadeOut !== undefined && { fadeOut: segment.fadeOut }),
  };
}

/**
 * Schedules the gain envelope for `segment` onto `gainNode.gain`, offline
 * counterpart to `@cadra/player`'s `scheduleGainEnvelope`
 * (`attach-audio.ts`): the same piecewise-linear breakpoint scheme
 * (`computeGainAtLocalFrame`'s curve, approximated via
 * `setValueAtTime`/`linearRampToValueAtTime`), but anchored to
 * `segmentStartSeconds` (this segment's absolute position in the rendered
 * buffer) rather than a live `AudioContext.currentTime`, and always
 * scheduled from the segment's very first frame (`localFrame` 0): an
 * offline render always renders a segment's entire window in one pass, so
 * there is no mid-segment resume point the way a live seek can produce.
 */
function scheduleGainEnvelope(
  gainNode: OfflineGainNodeLike,
  clip: AudioClip,
  fps: number,
  segmentStartSeconds: number,
): void {
  gainNode.gain.cancelScheduledValues(segmentStartSeconds);
  let lastScheduledGain = computeGainAtLocalFrame(clip, 0);
  gainNode.gain.setValueAtTime(lastScheduledGain, segmentStartSeconds);

  // Breakpoints where the envelope's slope can change: fadeIn's end,
  // fadeOut's start, clip end. Mirrors attach-audio.ts's own breakpoint list
  // (frame 0 is excluded here since it is always the pin above, never a
  // ramp target: an offline render always starts scheduling from a
  // segment's own frame 0).
  const breakpoints = [
    clip.fadeIn?.durationInFrames,
    clip.fadeOut !== undefined ? clip.durationInFrames - clip.fadeOut.durationInFrames : undefined,
    clip.durationInFrames,
  ].filter((frame): frame is number => frame !== undefined && frame > 0);

  const sortedUnique = [...new Set(breakpoints)].sort((a, b) => a - b);

  for (const breakpointFrame of sortedUnique) {
    const gainAtBreakpoint = computeGainAtLocalFrame(clip, breakpointFrame);
    if (gainAtBreakpoint === lastScheduledGain) {
      continue;
    }
    const audioTime = segmentStartSeconds + framesToSeconds(breakpointFrame, fps);
    gainNode.gain.linearRampToValueAtTime(gainAtBreakpoint, audioTime);
    lastScheduledGain = gainAtBreakpoint;
  }
}

/**
 * Schedules one `AudioMixdownSegment` onto `context`: creates a buffer
 * source + gain node, connects them, computes the source buffer offset from
 * `trimStartFrames`, and schedules the gain envelope, mirroring
 * `@cadra/player`'s `scheduleClip` (`attach-audio.ts`) but anchored to an
 * absolute position in the offline render rather than a live playhead.
 *
 * Schedules nothing (returns without creating any node) when
 * `resolveAudioBuffer` cannot resolve the segment's asset: a segment whose
 * audio is not available renders as silence for its whole window, matching
 * how a not-yet-ready clip is silently skipped during live playback (see
 * `ResolveAudioBufferFn`'s own doc).
 */
function scheduleSegment(
  context: OfflineAudioContextLike,
  segment: AudioMixdownSegment,
  fps: number,
  resolveAudioBuffer: ResolveAudioBufferFn,
): void {
  const buffer = resolveAudioBuffer(segment.assetRef);
  if (buffer === undefined) {
    return;
  }

  const segmentStartSeconds = frameToTime(segment.startFrame, fps);
  const bufferOffsetSeconds = framesToSeconds(segment.trimStartFrames, fps);
  const durationSeconds = framesToSeconds(segment.durationInFrames, fps);

  const source = context.createBufferSource();
  source.buffer = buffer;
  const gainNode = context.createGain();
  source.connect(gainNode);
  gainNode.connect(context.destination);

  const clip = segmentToAudioClip(segment);
  scheduleGainEnvelope(gainNode, clip, fps, segmentStartSeconds);
  source.start(segmentStartSeconds, bufferOffsetSeconds, durationSeconds);
}

/**
 * Renders `options.mixdown` (Phase 16's `resolveAudioMixdown` output) to a
 * single `AudioBufferLike` spanning the full composition, via an offline
 * audio context: every segment's clip is scheduled at its absolute
 * `startFrame` position (converted to seconds), with its gain envelope
 * applied, then the whole graph is rendered in one `startRendering()` pass.
 *
 * The rendered buffer's `length` always corresponds to exactly
 * `options.durationInFrames / options.fps` seconds at the render sample
 * rate, regardless of where the mixdown's segments actually start/end: a
 * mixdown with its first clip starting after frame 0 (or its last clip
 * ending before the composition's own end) still produces a buffer aligned
 * to frame 0 through the composition's full duration, silent everywhere no
 * segment covers. This is what lets the later muxing stage align audio and
 * video at the same zero point unconditionally, without needing to know
 * anything about where the mixdown's content actually lies.
 *
 * A mixdown with no segments (a composition with no `audioTracks`, or one
 * with only empty tracks; see `resolveAudioMixdown`'s own doc) still renders
 * a full-length, fully silent buffer here: this function itself has no
 * opinion on whether a silent render is worth encoding at all. That
 * decision belongs to a caller orchestrating the full render pipeline (this
 * phase's spec calls for skipping audio encoding/muxing entirely for a
 * silent composition, to avoid the wasted encode of a track nobody needs),
 * which can check `options.mixdown.segments.length === 0` itself before
 * ever calling this function.
 */
export async function renderAudioMixdown(
  options: RenderAudioMixdownOptions,
): Promise<AudioBufferLike> {
  const sampleRate = options.sampleRate ?? DEFAULT_RENDER_SAMPLE_RATE;
  const numberOfChannels = options.numberOfChannels ?? DEFAULT_RENDER_CHANNEL_COUNT;
  const durationSeconds = frameToTime(options.durationInFrames, options.fps);
  const length = Math.max(1, Math.ceil(durationSeconds * sampleRate));

  const defaultContextOptions: DefaultOfflineAudioContextOptions = {
    numberOfChannels,
    length,
    sampleRate,
  };
  const context =
    options.offlineAudioContext ?? createDefaultOfflineAudioContextLike(defaultContextOptions);

  for (const segment of options.mixdown.segments) {
    scheduleSegment(context, segment, options.fps, options.resolveAudioBuffer);
  }

  return context.startRendering();
}
