import {
  type AudioClip,
  type AudioTrack,
  CompositionNotFoundError,
  computeGainAtLocalFrame,
  type Project,
  resolveSequenceFrame,
} from "@cadra/core";

import type { Transport } from "../transport.js";
import {
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  createDefaultAudioContextLike,
  type GainNodeLike,
} from "./audio-context-like.js";

/**
 * Resolves `assetRef` (an `AudioClip.assetRef`) to its decoded `AudioBuffer`,
 * or `undefined` if it is not loaded (yet, or ever). Synchronous by design,
 * matching `Transport`'s own `IsFrameReadyFn`: scheduling happens inside a
 * synchronous `frameChanged`/wrapped-method handler, so this needs an answer
 * immediately, not a `Promise` to await mid-schedule. Anything tracking
 * asset readiness asynchronously elsewhere (e.g. `@cadra/renderer`'s
 * `loadAudio`) can trivially expose its already-resolved buffers through this
 * same synchronous shape.
 */
export type ResolveAudioBufferFn = (assetRef: string) => AudioBuffer | undefined;

/** Options accepted by `attachAudioToTransport`. */
export interface AttachAudioOptions {
  /** The project whose composition's `audioTracks` should be scheduled. */
  project: Project;
  /** Which of `project`'s compositions to schedule audio for. */
  compositionId: string;
  /** The `Transport` to synchronize audio playback with. */
  transport: Transport;
  /** Looks up a decoded `AudioBuffer` for a clip's `assetRef`. */
  resolveAudioBuffer: ResolveAudioBufferFn;
  /** The Web Audio dependency. Defaults to a real `AudioContext`. */
  audioContext?: AudioContextLike;
}

/** Imperative handle returned by `attachAudioToTransport`. */
export interface AudioTransportSync {
  /**
   * Stops every in-flight scheduled node, restores `transport`'s original
   * `play`/`pause`/`seek` methods, and unsubscribes from its events.
   * Idempotent.
   */
  dispose(): void;
}

/** One live node pair this module is currently tracking for one active `AudioClip`. */
interface ScheduledClip {
  clipId: string;
  source: AudioBufferSourceNodeLike;
  gainNode: GainNodeLike;
}

/** Frames-per-second conversion helper: `frames / fps` seconds, never negative. */
function framesToSeconds(frames: number, fps: number): number {
  return Math.max(frames, 0) / fps;
}

/**
 * Every `(track, clip)` pair across `audioTracks` whose window currently
 * covers `frame`, using `resolveSequenceFrame` for the exact same
 * half-open-window visibility rule `Clip`/`ActiveCameraEntry` already use.
 */
function findActiveClips(
  audioTracks: readonly AudioTrack[],
  frame: number,
): Array<{ track: AudioTrack; clip: AudioClip }> {
  const active: Array<{ track: AudioTrack; clip: AudioClip }> = [];
  for (const track of audioTracks) {
    for (const clip of track.clips) {
      if (resolveSequenceFrame(clip, frame).visible) {
        active.push({ track, clip });
      }
    }
  }
  return active;
}

/**
 * Schedules the gain envelope for `clip` onto `gainNode.gain`, approximating
 * `computeGainAtLocalFrame`'s piecewise-linear curve with a handful of
 * `setValueAtTime`/`linearRampToValueAtTime` calls anchored to real
 * `AudioContext` time.
 *
 * `startAudioTime` is the `AudioContext.currentTime` the source node begins
 * playing at; `startLocalFrame` is the clip-local frame it begins playing
 * from (usually where playback resumed after a seek, not necessarily `0`).
 * Every automation point at or after `startLocalFrame` gets one scheduled
 * call, each timed at `startAudioTime + (breakpointFrame - startLocalFrame) /
 * fps`; a breakpoint already passed (before `startLocalFrame`) is skipped,
 * except the value the envelope has *already reached* at `startLocalFrame`
 * itself, pinned immediately via `setValueAtTime` so playback starts at the
 * correct gain rather than ramping from whatever the node's default is. A
 * breakpoint whose gain does not actually differ from the value already
 * pinned/ramped-to schedules no further call: a clip with no fades (or past
 * the point its fades have finished) is exactly one `setValueAtTime` and
 * nothing else, not a series of ramps to an unchanged value.
 */
function scheduleGainEnvelope(
  gainNode: GainNodeLike,
  clip: AudioClip,
  fps: number,
  startAudioTime: number,
  startLocalFrame: number,
): void {
  gainNode.gain.cancelScheduledValues(startAudioTime);
  let lastScheduledGain = computeGainAtLocalFrame(clip, startLocalFrame);
  gainNode.gain.setValueAtTime(lastScheduledGain, startAudioTime);

  // Breakpoints where the envelope's slope can change: clip start, fadeIn's
  // end, fadeOut's start, clip end. Only ones strictly after startLocalFrame
  // need a ramp scheduled; earlier ones are already behind playback.
  const breakpoints = [
    0,
    clip.fadeIn?.durationInFrames,
    clip.fadeOut !== undefined ? clip.durationInFrames - clip.fadeOut.durationInFrames : undefined,
    clip.durationInFrames,
  ].filter((frame): frame is number => frame !== undefined && frame > startLocalFrame);

  // Ascending, de-duplicated: a clip whose fadeIn/fadeOut clamp to the same
  // frame (the too-short-clip case computeGainAtLocalFrame documents) would
  // otherwise schedule two ramps to two different times for the same frame.
  const sortedUnique = [...new Set(breakpoints)].sort((a, b) => a - b);

  for (const breakpointFrame of sortedUnique) {
    const gainAtBreakpoint = computeGainAtLocalFrame(clip, breakpointFrame);
    if (gainAtBreakpoint === lastScheduledGain) {
      continue;
    }
    const audioTime = startAudioTime + framesToSeconds(breakpointFrame - startLocalFrame, fps);
    gainNode.gain.linearRampToValueAtTime(gainAtBreakpoint, audioTime);
    lastScheduledGain = gainAtBreakpoint;
  }
}

/**
 * Starts a fresh `AudioBufferSourceNode`/`GainNode` pair for `clip`, playing
 * from `currentFrame` (which must be inside the clip's active window):
 * offset into the source buffer accounts for both `clip.trimStartFrames` and
 * how far into the clip's own window `currentFrame` already is, so playback
 * always begins at the correct trimmed position, never from the start of
 * the buffer.
 *
 * Returns `undefined` (schedules nothing) when `resolveAudioBuffer` cannot
 * yet resolve the clip's asset: a clip whose audio has not finished loading
 * is silently skipped rather than throwing, matching how a not-yet-ready
 * video frame is handled elsewhere in this package (see `IsFrameReadyFn`).
 */
function scheduleClip(
  audioContext: AudioContextLike,
  clip: AudioClip,
  fps: number,
  currentFrame: number,
  resolveAudioBuffer: ResolveAudioBufferFn,
): ScheduledClip | undefined {
  const buffer = resolveAudioBuffer(clip.assetRef);
  if (buffer === undefined) {
    return undefined;
  }

  const localFrame = currentFrame - clip.startFrame;
  const trimStartFrames = clip.trimStartFrames ?? 0;
  const bufferOffsetSeconds = framesToSeconds(trimStartFrames + localFrame, fps);
  const remainingDurationSeconds = framesToSeconds(clip.durationInFrames - localFrame, fps);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  const gainNode = audioContext.createGain();
  source.connect(gainNode);
  gainNode.connect(audioContext.destination);

  const startAudioTime = audioContext.currentTime;
  scheduleGainEnvelope(gainNode, clip, fps, startAudioTime, localFrame);
  source.start(startAudioTime, bufferOffsetSeconds, remainingDurationSeconds);

  return { clipId: clip.id, source, gainNode };
}

/** Stops and disconnects one scheduled node pair. Safe to call even if the node already finished naturally. */
function stopScheduledClip(scheduled: ScheduledClip, audioContext: AudioContextLike): void {
  try {
    scheduled.source.stop(audioContext.currentTime);
  } catch {
    // A source already stopped (or never started) throws on a real
    // AudioBufferSourceNode; nothing further to do either way.
  }
  scheduled.source.disconnect();
  scheduled.gainNode.disconnect();
}

/**
 * Attaches Web Audio scheduling to `transport`, keeping every currently-active
 * `AudioClip` across `project`'s composition `compositionId`'s `audioTracks`
 * played back in sync with `transport`'s frame-accurate clock.
 *
 * Does not fork or modify `Transport`'s own frame-clock logic: this module
 * never reaches into `createTransport`'s internals, and reads only
 * `transport`'s already-public surface (`currentFrame`, `on`/`off`, and its
 * `play`/`pause`/`seek` methods).
 *
 * `frameChanged` alone cannot distinguish "the frame advanced because
 * playback is progressing normally" from "the frame changed because of a
 * seek", and cannot observe `pause()` at all (`Transport.pause()` fires no
 * event and does not change `currentFrame`): both are simply not
 * observable through `Transport`'s public event surface. So this module
 * wraps `transport.play`/`transport.pause`/`transport.seek` in place (each
 * wrapper calls straight through to the original method, unchanged, then
 * performs a hard stop-everything-and-reschedule-from-scratch of audio),
 * which is the only way to react to those three actions at the exact moment
 * they happen rather than one tick late or not at all. Ordinary
 * frame-by-frame advancement during uninterrupted playback (a clip starting
 * or ending naturally mid-playback, with no seek/pause/play involved) is
 * instead handled by an incremental diff against the previous frame's active
 * set, driven by the `frameChanged` subscription: only clips that just
 * became active are scheduled, and only clips that just stopped being active
 * are torn down, so an already-correctly-playing clip is never interrupted
 * by a plain tick.
 */
export function attachAudioToTransport(options: AttachAudioOptions): AudioTransportSync {
  const composition = options.project.compositions.find(
    (candidate) => candidate.id === options.compositionId,
  );
  if (composition === undefined) {
    throw new CompositionNotFoundError(options.compositionId);
  }

  const { fps } = composition;
  const audioTracks = composition.audioTracks ?? [];
  const audioContext = options.audioContext ?? createDefaultAudioContextLike();
  const { transport, resolveAudioBuffer } = options;

  let scheduled: ScheduledClip[] = [];
  let isDisposed = false;

  function stopAll(): void {
    for (const entry of scheduled) {
      stopScheduledClip(entry, audioContext);
    }
    scheduled = [];
  }

  /** Unconditional hard reset: stop every scheduled node and reschedule fresh from `frame`, regardless of what was previously playing. */
  function rescheduleFrom(frame: number): void {
    stopAll();
    const active = findActiveClips(audioTracks, frame);
    const next: ScheduledClip[] = [];
    for (const { clip } of active) {
      const entry = scheduleClip(audioContext, clip, fps, frame, resolveAudioBuffer);
      if (entry !== undefined) {
        next.push(entry);
      }
    }
    scheduled = next;
  }

  /** Incremental reconciliation for ordinary tick-driven advancement: only starts newly-active clips and stops newly-inactive ones. */
  function reconcileAt(frame: number): void {
    const active = findActiveClips(audioTracks, frame);
    const activeClipIds = new Set(active.map(({ clip }) => clip.id));

    const stillActive: ScheduledClip[] = [];
    for (const entry of scheduled) {
      if (activeClipIds.has(entry.clipId)) {
        stillActive.push(entry);
      } else {
        stopScheduledClip(entry, audioContext);
      }
    }

    const scheduledClipIds = new Set(stillActive.map((entry) => entry.clipId));
    for (const { clip } of active) {
      if (scheduledClipIds.has(clip.id)) {
        continue;
      }
      const entry = scheduleClip(audioContext, clip, fps, frame, resolveAudioBuffer);
      if (entry !== undefined) {
        stillActive.push(entry);
      }
    }

    scheduled = stillActive;
  }

  // True for the duration of a wrapped play()/pause()/seek() call. Transport's
  // own seek()/setPlaybackRate() emit frameChanged synchronously (before
  // originalSeek even returns to the wrapper below), which would otherwise
  // make handleFrameChanged's incremental reconcileAt fire first, only for
  // the wrapper's own definitive rescheduleFrom/stopAll to immediately
  // supersede it: a correct final state, but via a redundant extra
  // schedule-then-immediately-stop of a node nobody needed. Suppressing the
  // subscription-driven reconcile while a wrapped call is already handling
  // this transition explicitly avoids that redundant churn.
  let isHandlingWrappedCall = false;

  function handleFrameChanged(frame: number): void {
    if (isDisposed || isHandlingWrappedCall) {
      return;
    }
    reconcileAt(frame);
  }

  function handleBuffering(isBuffering: boolean): void {
    if (isDisposed) {
      return;
    }
    // Buffering freezes the transport's frame clock; audio must freeze with
    // it rather than keep playing ahead of a frame that has stalled.
    if (isBuffering) {
      stopAll();
    } else {
      rescheduleFrom(transport.currentFrame);
    }
  }

  transport.on("frameChanged", handleFrameChanged);
  transport.on("buffering", handleBuffering);

  // Saved by reference, not re-bound: Transport's own play/pause/seek are
  // already closures over its internal state (see transport.ts), not methods
  // relying on `this`, so re-binding here would only produce a new function
  // identity that dispose() could never restore byte-for-byte.
  const originalPlay = transport.play;
  const originalPause = transport.pause;
  const originalSeek = transport.seek;

  transport.play = () => {
    isHandlingWrappedCall = true;
    try {
      originalPlay();
      // Not a hard rescheduleFrom: play() itself never changes currentFrame
      // (only a subsequent tick does), so whatever was already correctly
      // scheduled for this exact frame (at construction, or left in place
      // by a prior seek) must not be stopped and restarted here too.
      // pause() clears `scheduled` down to `[]` (its nodes are genuinely
      // gone), so this incremental reconcile schedules fresh nodes for
      // exactly the clips that need one, without touching anything already
      // playing.
      reconcileAt(transport.currentFrame);
    } finally {
      isHandlingWrappedCall = false;
    }
  };
  transport.pause = () => {
    isHandlingWrappedCall = true;
    try {
      originalPause();
      stopAll();
    } finally {
      isHandlingWrappedCall = false;
    }
  };
  transport.seek = (frame: number) => {
    isHandlingWrappedCall = true;
    try {
      originalSeek(frame);
      rescheduleFrom(transport.currentFrame);
    } finally {
      isHandlingWrappedCall = false;
    }
  };

  // Schedule whatever is active at the transport's current frame immediately
  // (matching how a fresh Transport already rendered frame 0 before any
  // play() call), so audio does not wait for a first play()/seek() to start
  // reflecting the initial frame's active clips once playback does begin.
  rescheduleFrom(transport.currentFrame);

  function dispose(): void {
    if (isDisposed) {
      return;
    }
    isDisposed = true;
    stopAll();
    transport.off("frameChanged", handleFrameChanged);
    transport.off("buffering", handleBuffering);
    transport.play = originalPlay;
    transport.pause = originalPause;
    transport.seek = originalSeek;
  }

  return { dispose };
}
