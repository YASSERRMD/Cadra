import type { Project } from "@cadra/core";

/**
 * Splits a render into frame ranges, dispatches each range to an injectable
 * per-range renderer through a bounded-concurrency worker pool, and tracks
 * per-range and overall job status, similar to a render farm's job
 * scheduler. This module owns the generic scheduling/retry/status
 * machinery only: it knows nothing about pixels, encoders, or muxing.
 *
 * `@cadra/headless` cannot depend on `@cadra/encode` (that package already
 * depends on this one, for `renderComposition`'s own types; see
 * `bundle-browser-entry.ts`'s doc for the same circular-dependency
 * constraint applied elsewhere in this package), so this module is
 * parameterized over an injectable `RenderRangeFn<TSegment>`: it does not
 * itself call `renderComposition`/`encodeFrames`/mux anything.
 * `@cadra/encode` is where the concrete default lives (rendering a range via
 * `renderComposition({ startFrame, endFrame })`, piping it through
 * `captureFrames`/`encodeFrames` with a fresh `VideoEncoder`, and
 * concatenating every range's resulting chunk sequence into a single final
 * mux pass); see that package's own `render-job.ts` for the wiring. This
 * mirrors exactly how `renderCompositionHeadlessServer` (this package) and
 * `runBrowserHeadlessRender` (`@cadra/encode`) already split "orchestration"
 * from "the actual render/encode pipeline" across the same package
 * boundary.
 *
 * Design rationale for range-parallel rendering producing output equivalent
 * to a sequential render, and why segment boundaries concatenate cleanly:
 * see `renderComposition`'s own doc (frame-range determinism) and this
 * module's `splitIntoFrameRanges` doc (keyframe-interval alignment).
 */

/** One contiguous, half-open frame range `[startFrame, endFrame)` a single worker renders. */
export interface FrameRange {
  /** Index into the job's own range list, counting from 0 in frame order. Stable identity for a range across retries/resumes. */
  rangeIndex: number;
  /** First frame (inclusive) this range covers. */
  startFrame: number;
  /** Frame index one past the last frame (exclusive) this range covers. */
  endFrame: number;
}

/**
 * Splits `[0, durationInFrames)` into contiguous, half-open `FrameRange`s, in
 * frame order, each range starting on a multiple of `alignmentFrames` (except
 * possibly the very first range, which always starts at `0` regardless of
 * `durationInFrames`'s own alignment) and spanning at most `rangeSizeFrames`
 * frames, rounded up to the next `alignmentFrames` boundary.
 *
 * Alignment is the key trick that makes independently-encoded ranges
 * concatenate into a single valid encoded stream: `@cadra/encode`'s
 * `encodeFrames` forces a keyframe at any frame whose absolute index is a
 * multiple of `keyframeIntervalFrames` (`isKeyframeDue`, default interval
 * `DEFAULT_KEYFRAME_INTERVAL_FRAMES`), so a range starting exactly on such a
 * boundary is guaranteed to open with a keyframe, both when rendered as
 * part of a full sequential encode and when rendered as its own
 * independent, freshly-keyed range: no extra keyframe is ever inserted that
 * a sequential encode would not also have placed at that exact frame, and
 * every range's own first frame is always independently decodable (no
 * range ever needs a preceding range's frames to decode its own opening
 * frame). Pass `alignmentFrames` matching (or an integer multiple of)
 * whatever `keyframeIntervalFrames` the encode step will use; the default
 * exported by this module, `DEFAULT_RANGE_ALIGNMENT_FRAMES`, matches
 * `@cadra/encode`'s own `DEFAULT_KEYFRAME_INTERVAL_FRAMES` exactly (kept as
 * an independently-defined constant here, not an import, for the same
 * circular-dependency reason described in this module's own top-level
 * doc).
 *
 * `rangeSizeFrames` is a target, not an exact size: the last range in a
 * composition whose `durationInFrames` does not divide evenly is always
 * shorter (it simply stops at `durationInFrames`), and every range's actual
 * length is rounded to remain aligned, so ranges may vary slightly in
 * length around the requested target. A `durationInFrames` of `0` produces
 * zero ranges.
 *
 * @throws {Error} if `rangeSizeFrames` or `alignmentFrames` is not a
 *   positive integer, or `durationInFrames` is negative.
 */
export function splitIntoFrameRanges(
  durationInFrames: number,
  rangeSizeFrames: number,
  alignmentFrames: number = DEFAULT_RANGE_ALIGNMENT_FRAMES,
): FrameRange[] {
  if (durationInFrames < 0 || !Number.isInteger(durationInFrames)) {
    throw new Error(
      `splitIntoFrameRanges: durationInFrames must be a non-negative integer, got ${durationInFrames}.`,
    );
  }
  if (rangeSizeFrames <= 0 || !Number.isInteger(rangeSizeFrames)) {
    throw new Error(
      `splitIntoFrameRanges: rangeSizeFrames must be a positive integer, got ${rangeSizeFrames}.`,
    );
  }
  if (alignmentFrames <= 0 || !Number.isInteger(alignmentFrames)) {
    throw new Error(
      `splitIntoFrameRanges: alignmentFrames must be a positive integer, got ${alignmentFrames}.`,
    );
  }

  // Round the requested target size up to the nearest multiple of
  // alignmentFrames (at least one alignment unit), so every range boundary
  // after the first lands on an alignment-frames multiple.
  const alignedRangeSize = Math.max(
    alignmentFrames,
    Math.ceil(rangeSizeFrames / alignmentFrames) * alignmentFrames,
  );

  const ranges: FrameRange[] = [];
  let startFrame = 0;
  let rangeIndex = 0;
  while (startFrame < durationInFrames) {
    const endFrame = Math.min(startFrame + alignedRangeSize, durationInFrames);
    ranges.push({ rangeIndex, startFrame, endFrame });
    startFrame = endFrame;
    rangeIndex += 1;
  }
  return ranges;
}

/**
 * Default range-start alignment: matches `@cadra/encode`'s
 * `DEFAULT_KEYFRAME_INTERVAL_FRAMES` (30 frames, one keyframe per second at a
 * common 30fps composition) exactly. Kept as an independent constant, not an
 * import, since `@cadra/headless` cannot depend on `@cadra/encode` (see this
 * module's own top-level doc); a caller using a non-default
 * `keyframeIntervalFrames` for encoding should pass the same value here as
 * `alignmentFrames`/`RenderJobOptions.rangeAlignmentFrames`.
 */
export const DEFAULT_RANGE_ALIGNMENT_FRAMES = 30;

/** Default number of frames a single range targets, before rounding to `alignmentFrames`. Modest by design: a caller rendering a short composition should still get more than one range out of the box, favoring parallelism over minimizing range count. */
export const DEFAULT_RANGE_SIZE_FRAMES = 120;

/** Default number of ranges rendered concurrently. Conservative: enough to overlap I/O/GPU-idle time across a couple of workers without assuming a caller's environment has many cores/GPU contexts available. */
export const DEFAULT_MAX_CONCURRENCY = 2;

/** Default per-range attempts (first try plus retries) before that range is declared failed. Mirrors `renderCompositionHeadlessServer`'s own `DEFAULT_MAX_ATTEMPTS`. */
export const DEFAULT_MAX_ATTEMPTS_PER_RANGE = 3;

/** A range's own lifecycle state, independent of every other range's. */
export type RangeStatus = "pending" | "running" | "done" | "failed";

/** One range's status snapshot: its bounds, current lifecycle state, attempt count so far, and (once `done`) its rendered segment. */
export interface RangeState<TSegment> {
  range: FrameRange;
  status: RangeStatus;
  /** Attempts made so far for this range (successful or not). Starts at `0` before the first attempt begins. */
  attempts: number;
  /** This range's rendered segment, once `status` is `"done"`; `undefined` otherwise. */
  segment?: TSegment;
  /** Every failed attempt's own error, in attempt order, so a caller can inspect exactly why each attempt failed. Cleared (reset to empty) if the range later succeeds on a subsequent resume. */
  errors: Error[];
}

/** Overall job status, derived from every range's own `RangeStatus`: see `deriveJobStatus`'s doc for the exact derivation rule. */
export type RenderJobStatus = "queued" | "running" | "done" | "failed";

/**
 * A render job's full status snapshot: overall `status`, every range's own
 * state (in frame order), and aggregate frame-level progress. Deliberately
 * plain, serializable data (no functions/handles), so it can cross a
 * process boundary, be logged, or be handed to a UI/API layer (e.g. Phase
 * 30's MCP render tools) without any adaptation.
 */
export interface RenderJobStatusSnapshot<TSegment> {
  status: RenderJobStatus;
  ranges: RangeState<TSegment>[];
  /** Total frames across every range, i.e. the full render's `durationInFrames`. */
  totalFrames: number;
  /** Sum of `endFrame - startFrame` across every range currently `"done"`. */
  framesCompleted: number;
}

/**
 * Derives a job's overall `RenderJobStatus` from its ranges' individual
 * statuses:
 * - `"failed"` if any range is `"failed"` (a job is only ever fully
 *   resolved once every range has either succeeded or exhausted its own
 *   retries; a single permanently-failed range fails the whole job, though
 *   every other range's own completed work is preserved for `resumeRenderJob`
 *   rather than discarded).
 * - `"done"` if every range is `"done"` (including the vacuous case of zero
 *   ranges, i.e. a `durationInFrames` of `0`).
 * - `"running"` if at least one range is `"running"`, or a mix of `"done"`
 *   and `"pending"` (dispatch is underway or ranges are still queued behind
 *   the concurrency limit).
 * - `"queued"` otherwise, i.e. every range is still `"pending"` and none
 *   has started yet.
 */
export function deriveJobStatus<TSegment>(ranges: readonly RangeState<TSegment>[]): RenderJobStatus {
  if (ranges.some((r) => r.status === "failed")) {
    return "failed";
  }
  if (ranges.every((r) => r.status === "done")) {
    return "done";
  }
  if (ranges.some((r) => r.status === "running" || r.status === "done")) {
    return "running";
  }
  return "queued";
}

/** Builds a `RenderJobStatusSnapshot` from `ranges`, deriving `status`/`framesCompleted` from their current state. */
export function buildJobStatusSnapshot<TSegment>(
  ranges: readonly RangeState<TSegment>[],
): RenderJobStatusSnapshot<TSegment> {
  const totalFrames = ranges.reduce((sum, r) => sum + (r.range.endFrame - r.range.startFrame), 0);
  const framesCompleted = ranges
    .filter((r) => r.status === "done")
    .reduce((sum, r) => sum + (r.range.endFrame - r.range.startFrame), 0);

  return {
    status: deriveJobStatus(ranges),
    // Copy each range's own state so a caller mutating the returned snapshot
    // (or a snapshot taken earlier and retained) never observes/causes a
    // spooky-action-at-a-distance change to this job's own live state.
    ranges: ranges.map((r) => ({ ...r, errors: [...r.errors] })),
    totalFrames,
    framesCompleted,
  };
}

/**
 * Renders one frame range to an opaque, caller-defined segment `TSegment`
 * (e.g. `@cadra/encode`'s wiring defines this as "an ordered array of
 * `EncodedChunkResult`s covering just this range," produced by a fresh
 * `renderComposition`/`captureFrames`/`encodeFrames` pipeline instance; see
 * this module's own top-level doc). Called once per attempt: a rejected
 * promise means this specific attempt failed and may be retried (up to
 * `RenderJobOptions.maxAttemptsPerRange`), not that the whole job failed.
 *
 * Receives `range` (this attempt's frame bounds) and `attempt` (`1` for the
 * first try, incrementing on each retry of the same range) so an
 * implementation can log/tag retries distinctly if useful; the function
 * itself is otherwise expected to be a plain, idempotent "render this exact
 * range from scratch" operation with no memory of a prior failed attempt's
 * partial state, mirroring `renderCompositionHeadlessServer`'s own
 * from-scratch-retry philosophy (see its doc for why a clean restart is
 * correct here, given `renderComposition`'s own full determinism).
 */
export type RenderRangeFn<TSegment> = (
  range: FrameRange,
  attempt: number,
) => Promise<TSegment>;

/** Options accepted by `submitRenderJob`. */
export interface RenderJobOptions<TSegment> {
  /** The project to render. Carried on the returned job/status only for a caller's own bookkeeping; never read by this module itself (only `renderRange` needs enough information to actually render, and it receives ranges, not `project`, directly - a caller's own `RenderRangeFn` closes over whatever project/compositionId/seed/format it needs). */
  project: Project;
  /** Which of `project`'s compositions this job renders. Carried through for the same bookkeeping reason as `project`. */
  compositionId: string;
  /** Total frames to split into ranges, i.e. the target composition's own `durationInFrames`. */
  durationInFrames: number;
  /**
   * Renders one frame range to its own segment; see `RenderRangeFn`'s own
   * doc. Required: this module has no default (it does not know how to
   * render anything itself; see this module's own top-level doc for why).
   */
  renderRange: RenderRangeFn<TSegment>;
  /** Target frames per range, before alignment rounding. Defaults to `DEFAULT_RANGE_SIZE_FRAMES`. */
  rangeSizeFrames?: number;
  /** Range-start alignment, in frames; see `splitIntoFrameRanges`'s own doc. Defaults to `DEFAULT_RANGE_ALIGNMENT_FRAMES`. */
  rangeAlignmentFrames?: number;
  /** Maximum ranges rendered concurrently. Defaults to `DEFAULT_MAX_CONCURRENCY`. */
  maxConcurrency?: number;
  /** Maximum attempts (first try plus retries) per range before that range is declared permanently failed. Defaults to `DEFAULT_MAX_ATTEMPTS_PER_RANGE`. */
  maxAttemptsPerRange?: number;
  /** Invoked whenever any range's own status changes (including `"running"` -> `"running"` transitions across retries), with the job's full up-to-date status snapshot. Optional; a caller not interested in incremental updates can instead only ever call `getRenderJobStatus`/inspect the resolved `RenderJobHandle.result`. */
  onStatusChange?: (status: RenderJobStatusSnapshot<TSegment>) => void;
}

/**
 * A submitted render job's live handle: an id for `getRenderJobStatus`, plus
 * a `result` promise a caller can await for final completion (resolving
 * with every range's segment, in frame order, once every range succeeds;
 * rejecting with `RenderJobFailedError` if any range permanently fails,
 * after every other range has finished attempting).
 */
export interface RenderJobHandle<TSegment> {
  /** Opaque id for `getRenderJobStatus`. Unique per `submitRenderJob`/`resumeRenderJob` call. */
  jobId: string;
  /**
   * Resolves with every range's own segment, in frame order (`range 0`'s
   * segment first), once every range has succeeded. Rejects with
   * `RenderJobFailedError` once at least one range has permanently failed
   * and every still-in-flight range has finished its own current attempt
   * (this job never abandons a range mid-attempt just because a sibling
   * range failed elsewhere; see `runRenderJob`'s own doc for why).
   */
  result: Promise<TSegment[]>;
}

/** Thrown by a job's `result` promise when at least one range permanently failed (exhausted `maxAttemptsPerRange`). */
export class RenderJobFailedError extends Error {
  /** Every permanently-failed range's own state (rangeIndex, bounds, and every attempt's error), in frame order. */
  readonly failedRanges: readonly RangeState<unknown>[];

  constructor(failedRanges: readonly RangeState<unknown>[]) {
    const summary = failedRanges
      .map(
        (r) =>
          `  range ${r.range.rangeIndex} [${r.range.startFrame}, ${r.range.endFrame}): ${r.errors
            .map((e, i) => `attempt ${i + 1}: ${e.message}`)
            .join("; ")}`,
      )
      .join("\n");
    super(
      `renderJob: ${failedRanges.length} range(s) permanently failed after exhausting their own retries.\n${summary}`,
    );
    this.name = "RenderJobFailedError";
    this.failedRanges = failedRanges;
  }
}

/**
 * A resumable snapshot of a job's own per-range state, as accepted by
 * `resumeRenderJob`. Plain, serializable data (`TSegment` permitting):
 * a caller can persist `RenderJobStatusSnapshot.ranges` (e.g. to disk, or a
 * database row per render-farm job) after a process exits mid-job, and pass
 * it back into `resumeRenderJob` later (potentially in an entirely new
 * process) to continue exactly where it left off, re-attempting only
 * ranges that are not yet `"done"`.
 */
export type ResumableRangeStates<TSegment> = readonly RangeState<TSegment>[];

/**
 * A minimal, injectable concurrency limiter: `run(task)` queues `task` and
 * resolves/rejects with whatever `task()` itself resolves/rejects with,
 * running at most `maxConcurrency` tasks at once. Default implementation
 * used by `runRenderJob` when no override is supplied; kept as an
 * injectable seam (mirroring this codebase's `BrowserLauncher`/
 * `ReadPixelsFn` pattern) purely so a test can substitute a deterministic,
 * manually-steppable fake if ever needed, though the real implementation
 * below is itself fully deterministic given deterministic tasks (it has no
 * timers, wall-clock reads, or real I/O of its own).
 */
export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * The real `ConcurrencyLimiter`: a simple FIFO queue gated by an in-flight
 * counter. `run`'s returned promise settles exactly when `task()`'s own
 * promise settles (this limiter adds no extra microtask delay beyond
 * `task()`'s own asynchrony once a slot is available), and the next queued
 * task starts as soon as a running one settles, whether it resolved or
 * rejected (one range's failure never blocks the concurrency slot it held
 * from being handed to the next queued range).
 */
export function createDefaultConcurrencyLimiter(maxConcurrency: number): ConcurrencyLimiter {
  if (maxConcurrency <= 0 || !Number.isInteger(maxConcurrency)) {
    throw new Error(
      `createDefaultConcurrencyLimiter: maxConcurrency must be a positive integer, got ${maxConcurrency}.`,
    );
  }

  let inFlight = 0;
  const queue: Array<() => void> = [];

  function schedule(): void {
    if (inFlight >= maxConcurrency) {
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      return;
    }
    inFlight += 1;
    next();
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          task()
            .then(resolve, reject)
            .finally(() => {
              inFlight -= 1;
              schedule();
            });
        });
        schedule();
      });
    },
  };
}

/**
 * Runs every `"pending"`/`"failed"`-and-retriable range in `ranges` through
 * `options.renderRange`, via `limiter`, mutating each `RangeState` in place
 * as it progresses (`"pending"` -> `"running"` -> `"done"`, or back to
 * `"pending"` for a retry, or `"failed"` once `maxAttemptsPerRange` is
 * exhausted) and invoking `onStatusChange` after every transition.
 *
 * Ranges already `"done"` (e.g. from a prior `resumeRenderJob` call) are
 * left untouched and never re-rendered: this is the core of this module's
 * resume behavior, since a range's own `attempts`/`errors`/`segment` are
 * exactly what a resumed run needs to know not to redo already-succeeded
 * work.
 *
 * Every outstanding range's own attempts run to their own conclusion
 * (success or permanent failure) even after a sibling range has already
 * permanently failed: this job never cancels a range mid-flight just
 * because another one failed, since doing so would discard real,
 * potentially-expensive rendering work for no benefit (the failed range's
 * own failure does not become less true, or the job's overall failure
 * status any less certain, by also throwing away a different range's
 * independent, otherwise-successful progress). This is also exactly what
 * makes `resumeRenderJob` meaningful after a partial failure: every
 * non-failed range's segment is already sitting in `ranges` by the time this
 * function's returned promise settles.
 *
 * Resolves once every range has reached a terminal status (`"done"` or
 * `"failed"`); never itself throws (the caller, `submitRenderJob`/
 * `resumeRenderJob`, derives the job's own `result` promise's
 * resolution/rejection from the final `ranges` state once this resolves).
 */
async function runRenderJob<TSegment>(
  ranges: RangeState<TSegment>[],
  options: {
    renderRange: RenderRangeFn<TSegment>;
    maxAttemptsPerRange: number;
    limiter: ConcurrencyLimiter;
    onStatusChange?: (status: RenderJobStatusSnapshot<TSegment>) => void;
  },
): Promise<void> {
  const notify = (): void => {
    options.onStatusChange?.(buildJobStatusSnapshot(ranges));
  };

  async function attemptRange(state: RangeState<TSegment>): Promise<void> {
    state.status = "running";
    notify();

    for (let attempt = state.attempts + 1; attempt <= options.maxAttemptsPerRange; attempt += 1) {
      state.attempts = attempt;
      try {
        // Sequential retries for one single range are deliberately serial
        // (attempt 2 must not start before attempt 1 has fully settled);
        // concurrency across *different* ranges is what `limiter` (this
        // function's own outer caller) provides, not this inner per-range
        // retry loop.
        const segment = await options.renderRange(state.range, attempt);
        state.segment = segment;
        state.status = "done";
        notify();
        return;
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        state.errors.push(normalized);
        notify();
      }
    }

    state.status = "failed";
    notify();
  }

  const outstanding = ranges.filter((state) => state.status !== "done");
  await Promise.all(outstanding.map((state) => options.limiter.run(() => attemptRange(state))));
}

let nextJobId = 1;

/** Generates a fresh, process-local job id (`"render-job-<n>"`). Not globally unique across processes/machines: a caller persisting a job across process boundaries (for `resumeRenderJob`) should track its own external identifier alongside this one if that matters for its use case. */
function generateJobId(): string {
  const id = `render-job-${nextJobId}`;
  nextJobId += 1;
  return id;
}

/**
 * Submits a new render job: splits `options.durationInFrames` into frame
 * ranges (`splitIntoFrameRanges`, aligned per `options.rangeAlignmentFrames`),
 * then dispatches every range to `options.renderRange` through a
 * bounded-concurrency worker pool (`options.maxConcurrency` at once),
 * retrying each range independently up to `options.maxAttemptsPerRange`
 * times on its own failures.
 *
 * Returns immediately with a `RenderJobHandle`: dispatch begins right away
 * (not lazily on first `await`/`getRenderJobStatus` call), matching a real
 * render farm's "submit a job, it starts scheduling immediately" behavior.
 * Poll progress via `getRenderJobStatus(handle.jobId)` (this module also
 * keeps a live registry so a jobId alone, without retaining the original
 * handle, is enough to query status - see that function's own doc), or
 * `await handle.result` for final completion.
 *
 * A `durationInFrames` of `0` produces a job with zero ranges, which is
 * vacuously `"done"` immediately (`handle.result` resolves to `[]`).
 */
export function submitRenderJob<TSegment>(
  options: RenderJobOptions<TSegment>,
): RenderJobHandle<TSegment> {
  const rangeSizeFrames = options.rangeSizeFrames ?? DEFAULT_RANGE_SIZE_FRAMES;
  const rangeAlignmentFrames = options.rangeAlignmentFrames ?? DEFAULT_RANGE_ALIGNMENT_FRAMES;
  const ranges = splitIntoFrameRanges(options.durationInFrames, rangeSizeFrames, rangeAlignmentFrames);
  const rangeStates: RangeState<TSegment>[] = ranges.map((range) => ({
    range,
    status: "pending",
    attempts: 0,
    errors: [],
  }));

  return startJobFromRangeStates(rangeStates, options);
}

/**
 * Resumes a previously-submitted job from a `RenderJobStatusSnapshot`'s (or
 * `getRenderJobStatus`'s) own `ranges` array: every range already `"done"` is
 * kept as-is and never re-rendered, and every `"pending"`/`"failed"`/
 * `"running"` range (a `"running"` range in a resumed snapshot means the
 * process that owned it exited before that range's own attempt settled; its
 * `attempts` count is preserved, so a resumed retry continues counting
 * toward the same `maxAttemptsPerRange` budget rather than resetting it) is
 * re-attempted from scratch via `options.renderRange`, exactly as a fresh
 * `submitRenderJob` attempt would.
 *
 * This is this module's resume story end to end: a caller that persisted a
 * `RenderJobStatusSnapshot.ranges` (e.g. to disk) after a process exited
 * mid-job passes it back in here (in a new process, potentially) to
 * continue without redoing any range that already succeeded. `options`
 * mirrors `RenderJobOptions` minus `durationInFrames` (implied by
 * `previousRanges` itself) and `rangeSizeFrames`/`rangeAlignmentFrames`
 * (ranges are already fixed by `previousRanges`, not re-split).
 *
 * @throws {Error} if `previousRanges` is empty and was not itself the
 *   result of a legitimate zero-duration (`durationInFrames: 0`) job: an
 *   empty range list from any other source most likely means a caller
 *   passed the wrong snapshot (e.g. an un-submitted job's initial state, or
 *   a totally unrelated job), so this is rejected rather than silently
 *   "succeeding" a job that never actually ran anything. Distinguishing a
 *   legitimate empty job from a mistaken one is impossible from
 *   `previousRanges` alone, so this validates the one thing it safely can:
 *   `resumeRenderJob` must not be the first thing that ever populates a
 *   job's ranges (that is `submitRenderJob`'s own responsibility).
 */
export function resumeRenderJob<TSegment>(
  previousRanges: ResumableRangeStates<TSegment>,
  options: Omit<RenderJobOptions<TSegment>, "durationInFrames" | "rangeSizeFrames" | "rangeAlignmentFrames">,
): RenderJobHandle<TSegment> {
  const rangeStates: RangeState<TSegment>[] = previousRanges.map((state) => ({
    ...state,
    // A range resumed mid-"running" (its owning process exited before that
    // attempt settled) is treated as needing a fresh attempt: it is not
    // "done", and `runRenderJob`'s own `outstanding` filter (anything not
    // already "done") picks it back up correctly once reset to "pending"
    // here.
    status: state.status === "done" ? "done" : "pending",
    errors: [...state.errors],
  }));

  return startJobFromRangeStates(rangeStates, options);
}

/** Shared by `submitRenderJob`/`resumeRenderJob`: registers `rangeStates` under a fresh job id, kicks off `runRenderJob`, and derives `handle.result` from the final state once it settles. */
function startJobFromRangeStates<TSegment>(
  rangeStates: RangeState<TSegment>[],
  options: {
    renderRange: RenderRangeFn<TSegment>;
    maxAttemptsPerRange?: number;
    maxConcurrency?: number;
    onStatusChange?: (status: RenderJobStatusSnapshot<TSegment>) => void;
  },
): RenderJobHandle<TSegment> {
  const jobId = generateJobId();
  const maxAttemptsPerRange = options.maxAttemptsPerRange ?? DEFAULT_MAX_ATTEMPTS_PER_RANGE;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const limiter = createDefaultConcurrencyLimiter(maxConcurrency);

  jobRegistry.set(jobId, rangeStates as RangeState<unknown>[]);

  const result = runRenderJob(rangeStates, {
    renderRange: options.renderRange,
    maxAttemptsPerRange,
    limiter,
    onStatusChange: options.onStatusChange,
  }).then(() => {
    const failed = rangeStates.filter((state) => state.status === "failed");
    if (failed.length > 0) {
      throw new RenderJobFailedError(failed as RangeState<unknown>[]);
    }
    return rangeStates
      .slice()
      .sort((a, b) => a.range.rangeIndex - b.range.rangeIndex)
      .map((state) => {
        // Every non-failed range is "done" by this point (runRenderJob only
        // resolves once every range has reached a terminal status, and
        // `failed` above is empty), so `segment` is always populated here.
        // Guarded rather than asserted so a future bug in runRenderJob's
        // own bookkeeping fails with a clear message instead of silently
        // returning `undefined` as if it were a valid TSegment.
        if (state.segment === undefined) {
          throw new Error(
            `renderJob: range ${state.range.rangeIndex} finished without a segment despite not being marked failed; this indicates a bug in runRenderJob's own status bookkeeping.`,
          );
        }
        return state.segment;
      });
  });

  return { jobId, result };
}

/**
 * Process-local registry of every job's live `RangeState` array, keyed by
 * `jobId`. Lets `getRenderJobStatus` be called with just a `jobId` string
 * (e.g. from a caller that only persisted the id, not the original
 * `RenderJobHandle`, such as an HTTP/MCP layer serving status-poll requests
 * across separate calls) rather than requiring the original handle object to
 * be threaded through. Entries are never evicted, deliberately: a finished
 * job's final status remains queryable for the lifetime of this process
 * (mirroring a render farm's job history), and the memory this holds onto
 * (every range's own small status/attempts/segment) is bounded by how many
 * jobs a given process actually submits, not by anything unbounded.
 */
const jobRegistry = new Map<string, RangeState<unknown>[]>();

/** Thrown by `getRenderJobStatus` when `jobId` names no job this process has ever submitted/resumed. */
export class RenderJobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`getRenderJobStatus: no render job with id "${jobId}" is known to this process.`);
    this.name = "RenderJobNotFoundError";
  }
}

/**
 * Returns `jobId`'s current `RenderJobStatusSnapshot`: overall status, every
 * range's own state, and aggregate frame progress, read live off this
 * process's job registry (see its own doc). Safe to call at any point in a
 * job's lifecycle, including after it has fully finished (successfully or
 * not); the returned snapshot is a point-in-time copy (see
 * `buildJobStatusSnapshot`'s own doc), not a live view that mutates
 * underneath a caller holding onto it.
 *
 * This is the query half of this module's job-status API (`submitRenderJob`/
 * `resumeRenderJob`'s returned handle covers the "act on a specific job I
 * just started" half); kept as a free function taking a plain `jobId`
 * string (not a method on `RenderJobHandle`) specifically so a later
 * caller that only has an id (e.g. Phase 30's MCP render tools, serving a
 * "check status of job X" request with no handle object available) can
 * still poll status.
 *
 * @throws {RenderJobNotFoundError} if `jobId` names no known job.
 */
export function getRenderJobStatus<TSegment = unknown>(jobId: string): RenderJobStatusSnapshot<TSegment> {
  const ranges = jobRegistry.get(jobId);
  if (ranges === undefined) {
    throw new RenderJobNotFoundError(jobId);
  }
  return buildJobStatusSnapshot(ranges as RangeState<TSegment>[]);
}
