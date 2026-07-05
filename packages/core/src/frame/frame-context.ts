import { frameToTime } from "./frame-time.js";
import { createFrameRandom, type FrameRandom } from "./prng.js";

/**
 * The deterministic time model for a single evaluated frame.
 *
 * Everything the renderer needs to reproduce one frame's scene state lives
 * here, and nothing here comes from a wall clock: `frame` is the only source
 * of truth for "when" a frame is, `time` is derived from it, and `seed`
 * makes any randomness used while evaluating this frame reproducible too.
 * Constructing a `FrameContext` twice with identical inputs yields identical
 * plain-data fields both times, and `structuredClone`/JSON round trips
 * preserve them exactly.
 *
 * `seed` is a runtime/ephemeral concept supplied by whatever resolves a
 * frame (e.g. a render job or the live player), not part of the persisted
 * Phase 2 scene graph: two renders of the same `Project` with different
 * seeds are both valid, reproducible renders, just different ones.
 *
 * `random()` is attached as a convenience method rather than a plain field
 * because a `FrameRandom` is stateful (it advances as you draw from it), so
 * it cannot be a directly-comparable plain-data field the way `frame`,
 * `fps`, `time`, `durationInFrames`, and `seed` are. Calling `random()`
 * multiple times on the same context returns independent generators that all
 * produce the same sequence, since it is derived fresh from `(seed, frame)`
 * every time rather than cached or advanced as a side effect of the call.
 */
export interface FrameContext {
  /** Integer index of the frame being evaluated, counting from 0. */
  readonly frame: number;
  /** Frames per second for this evaluation. */
  readonly fps: number;
  /** Time in seconds corresponding to `frame`, i.e. `frame / fps`. */
  readonly time: number;
  /** Total length of the timeline this frame belongs to, in frames. */
  readonly durationInFrames: number;
  /** Base seed for reproducible randomness across the whole render. */
  readonly seed: string | number;
  /**
   * Returns a fresh `FrameRandom` deterministically derived from this
   * context's `seed` and `frame`. Safe to call more than once; every call
   * yields a generator producing the same sequence as any other, since none
   * of them share or mutate state with each other.
   */
  random: () => FrameRandom;
}

/** Input to `createFrameContext`. */
export interface CreateFrameContextInput {
  /** Integer index of the frame being evaluated, counting from 0. */
  frame: number;
  /** Frames per second for this evaluation. */
  fps: number;
  /** Total length of the timeline this frame belongs to, in frames. */
  durationInFrames: number;
  /** Base seed for reproducible randomness across the whole render. */
  seed: string | number;
}

/**
 * Constructs a `FrameContext` from `{ frame, fps, durationInFrames, seed }`,
 * computing `time` as `frame / fps`.
 *
 * This is the only place a `FrameContext` should be built: scene-authoring
 * and evaluation code receives the resulting context explicitly and never
 * constructs its own or reaches for an ambient/global one.
 */
export function createFrameContext(input: CreateFrameContextInput): FrameContext {
  const { frame, fps, durationInFrames, seed } = input;
  const time = frameToTime(frame, fps);

  return {
    frame,
    fps,
    time,
    durationInFrames,
    seed,
    random(): FrameRandom {
      return createFrameRandom(seed, frame);
    },
  };
}
