import { createComposition, createProject, type Project, Sequence, Shape } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import {
  buildJobStatusSnapshot,
  createDefaultConcurrencyLimiter,
  DEFAULT_MAX_ATTEMPTS_PER_RANGE,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_RANGE_ALIGNMENT_FRAMES,
  DEFAULT_RANGE_SIZE_FRAMES,
  deriveJobStatus,
  type FrameRange,
  getRenderJobStatus,
  type RangeState,
  RenderJobFailedError,
  RenderJobNotFoundError,
  type RenderJobStatusSnapshot,
  resumeRenderJob,
  splitIntoFrameRanges,
  submitRenderJob,
} from "./render-job-orchestrator.js";

/** A small project, mirroring `render-composition.test.ts`'s own `buildProject` helper. */
function buildProject(durationInFrames = 12): Project {
  const shape = Shape({ id: "shape-1" });
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: 30,
    durationInFrames,
    width: 64,
    height: 36,
    tracks: [
      {
        id: "track-1",
        clips: [Sequence({ id: "clip-1", from: 0, durationInFrames, content: shape })],
      },
    ],
  });
  return createProject({ id: "p1", name: "Project", compositions: [composition] });
}

describe("splitIntoFrameRanges", () => {
  it("produces zero ranges for durationInFrames 0", () => {
    expect(splitIntoFrameRanges(0, 30, 30)).toEqual([]);
  });

  it("produces one range covering everything when durationInFrames <= the aligned range size", () => {
    expect(splitIntoFrameRanges(10, 30, 30)).toEqual([
      { rangeIndex: 0, startFrame: 0, endFrame: 10 },
    ]);
  });

  it("splits evenly-divisible durations into equal, alignment-boundary ranges", () => {
    expect(splitIntoFrameRanges(90, 30, 30)).toEqual([
      { rangeIndex: 0, startFrame: 0, endFrame: 30 },
      { rangeIndex: 1, startFrame: 30, endFrame: 60 },
      { rangeIndex: 2, startFrame: 60, endFrame: 90 },
    ]);
  });

  it("the last range is shorter when durationInFrames does not divide evenly, still starting on an alignment boundary", () => {
    const ranges = splitIntoFrameRanges(100, 30, 30);
    expect(ranges).toEqual([
      { rangeIndex: 0, startFrame: 0, endFrame: 30 },
      { rangeIndex: 1, startFrame: 30, endFrame: 60 },
      { rangeIndex: 2, startFrame: 60, endFrame: 90 },
      { rangeIndex: 3, startFrame: 90, endFrame: 100 },
    ]);
    // Every range but the last starts on a multiple of the alignment value.
    for (const range of ranges.slice(0, -1)) {
      expect(range.startFrame % 30).toBe(0);
      expect(range.endFrame % 30).toBe(0);
    }
    expect(ranges[ranges.length - 1]?.startFrame ?? -1).toBe(90);
  });

  it("rounds a rangeSizeFrames that is not itself a multiple of alignmentFrames up to the next alignment boundary", () => {
    // rangeSizeFrames=40 with alignmentFrames=30 rounds up to 60.
    const ranges = splitIntoFrameRanges(120, 40, 30);
    expect(ranges).toEqual([
      { rangeIndex: 0, startFrame: 0, endFrame: 60 },
      { rangeIndex: 1, startFrame: 60, endFrame: 120 },
    ]);
  });

  it("covers [0, durationInFrames) with no gaps and no overlaps for a variety of shapes", () => {
    for (const [duration, size, alignment] of [
      [7, 30, 30],
      [30, 30, 30],
      [31, 30, 30],
      [301, 25, 10],
      [1, 1, 1],
    ] as const) {
      const ranges = splitIntoFrameRanges(duration, size, alignment);
      let expectedStart = 0;
      for (const range of ranges) {
        expect(range.startFrame).toBe(expectedStart);
        expect(range.endFrame).toBeGreaterThan(range.startFrame);
        expectedStart = range.endFrame;
      }
      expect(expectedStart).toBe(duration);
    }
  });

  it("assigns rangeIndex in increasing frame order starting from 0", () => {
    const ranges = splitIntoFrameRanges(90, 30, 30);
    expect(ranges.map((r) => r.rangeIndex)).toEqual([0, 1, 2]);
  });

  it("defaults rangeSizeFrames/alignmentFrames match the module's exported defaults when a caller uses them explicitly", () => {
    const withDefaults = splitIntoFrameRanges(
      500,
      DEFAULT_RANGE_SIZE_FRAMES,
      DEFAULT_RANGE_ALIGNMENT_FRAMES,
    );
    const withExplicitDefault = splitIntoFrameRanges(500, 120, 30);
    expect(withDefaults).toEqual(withExplicitDefault);
  });

  it("throws for a negative durationInFrames, a non-positive rangeSizeFrames, or a non-positive alignmentFrames", () => {
    expect(() => splitIntoFrameRanges(-1, 30, 30)).toThrow();
    expect(() => splitIntoFrameRanges(10, 0, 30)).toThrow();
    expect(() => splitIntoFrameRanges(10, 30, 0)).toThrow();
    expect(() => splitIntoFrameRanges(10, 1.5, 30)).toThrow();
  });
});

/** Builds a minimal `RangeState<string>` for `deriveJobStatus`/`buildJobStatusSnapshot` tests, without going through a real job. */
function state(
  rangeIndex: number,
  status: RangeState<string>["status"],
  overrides: Partial<RangeState<string>> = {},
): RangeState<string> {
  const range: FrameRange = {
    rangeIndex,
    startFrame: rangeIndex * 10,
    endFrame: rangeIndex * 10 + 10,
  };
  return { range, status, attempts: status === "pending" ? 0 : 1, errors: [], ...overrides };
}

describe("deriveJobStatus", () => {
  it("is 'done' for zero ranges (a vacuous, durationInFrames-0 job)", () => {
    expect(deriveJobStatus([])).toBe("done");
  });

  it("is 'queued' when every range is still pending", () => {
    expect(deriveJobStatus([state(0, "pending"), state(1, "pending")])).toBe("queued");
  });

  it("is 'running' when at least one range is running", () => {
    expect(deriveJobStatus([state(0, "running"), state(1, "pending")])).toBe("running");
  });

  it("is 'running' for a mix of done and pending (dispatch still underway)", () => {
    expect(deriveJobStatus([state(0, "done"), state(1, "pending")])).toBe("running");
  });

  it("is 'done' when every range is done", () => {
    expect(deriveJobStatus([state(0, "done"), state(1, "done")])).toBe("done");
  });

  it("is 'failed' if any range failed, even if every other range is done", () => {
    expect(deriveJobStatus([state(0, "done"), state(1, "failed")])).toBe("failed");
  });

  it("prioritizes 'failed' over every other mix (failed + running)", () => {
    expect(deriveJobStatus([state(0, "failed"), state(1, "running")])).toBe("failed");
  });
});

describe("buildJobStatusSnapshot", () => {
  it("sums totalFrames/framesCompleted correctly across mixed-length ranges", () => {
    const ranges: RangeState<string>[] = [
      {
        range: { rangeIndex: 0, startFrame: 0, endFrame: 30 },
        status: "done",
        attempts: 1,
        errors: [],
      },
      {
        range: { rangeIndex: 1, startFrame: 30, endFrame: 50 },
        status: "running",
        attempts: 1,
        errors: [],
      },
      {
        range: { rangeIndex: 2, startFrame: 50, endFrame: 90 },
        status: "pending",
        attempts: 0,
        errors: [],
      },
    ];

    const snapshot = buildJobStatusSnapshot(ranges);
    expect(snapshot.totalFrames).toBe(90);
    expect(snapshot.framesCompleted).toBe(30);
    expect(snapshot.status).toBe("running");
  });

  it("returns a snapshot that does not mutate when the underlying ranges array later changes (a defensive copy)", () => {
    const ranges: RangeState<string>[] = [state(0, "pending")];
    const snapshot = buildJobStatusSnapshot(ranges);

    ranges[0]!.status = "done";
    ranges[0]!.errors.push(new Error("mutated after snapshot"));

    expect(snapshot.ranges[0]?.status).toBe("pending");
    expect(snapshot.ranges[0]?.errors).toEqual([]);
  });
});

describe("createDefaultConcurrencyLimiter", () => {
  it("runs at most maxConcurrency tasks at once, queuing the rest", async () => {
    const limiter = createDefaultConcurrencyLimiter(2);
    let running = 0;
    let maxObservedRunning = 0;
    const resolvers: Array<() => void> = [];

    function makeTask(): () => Promise<void> {
      return () =>
        new Promise<void>((resolve) => {
          running += 1;
          maxObservedRunning = Math.max(maxObservedRunning, running);
          resolvers.push(() => {
            running -= 1;
            resolve();
          });
        });
    }

    const results = [limiter.run(makeTask()), limiter.run(makeTask()), limiter.run(makeTask())];

    // Give the two initially-runnable tasks a chance to start; the third
    // must still be queued (only 2 concurrency slots).
    await vi.waitFor(() => expect(resolvers.length).toBe(2));
    expect(running).toBe(2);

    resolvers[0]?.();
    await vi.waitFor(() => expect(resolvers.length).toBe(3));

    resolvers[1]?.();
    resolvers[2]?.();
    await Promise.all(results);

    expect(maxObservedRunning).toBe(2);
  });

  it("starts the next queued task even when an earlier one rejects", async () => {
    const limiter = createDefaultConcurrencyLimiter(1);
    const order: string[] = [];

    const first = limiter.run(async () => {
      order.push("first-start");
      throw new Error("first failed");
    });
    const second = limiter.run(async () => {
      order.push("second-start");
      return "second-result";
    });

    await expect(first).rejects.toThrow("first failed");
    await expect(second).resolves.toBe("second-result");
    expect(order).toEqual(["first-start", "second-start"]);
  });

  it("resolves/rejects with exactly what the task itself resolves/rejects with", async () => {
    const limiter = createDefaultConcurrencyLimiter(3);
    await expect(limiter.run(async () => 42)).resolves.toBe(42);
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
  });

  it("throws for a non-positive or non-integer maxConcurrency", () => {
    expect(() => createDefaultConcurrencyLimiter(0)).toThrow();
    expect(() => createDefaultConcurrencyLimiter(-1)).toThrow();
    expect(() => createDefaultConcurrencyLimiter(1.5)).toThrow();
  });
});

/** Builds a `renderRange` that always succeeds immediately, returning `"segment-<rangeIndex>"`. */
function alwaysSucceeds(): (range: FrameRange, attempt: number) => Promise<string> {
  return async (range) => `segment-${range.rangeIndex}`;
}

describe("submitRenderJob: basic scheduling and completion", () => {
  it("splits into ranges, renders every one, and resolves handle.result with every segment in frame order", async () => {
    const project = buildProject(90);
    const calls: FrameRange[] = [];

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 90,
      rangeSizeFrames: 30,
      rangeAlignmentFrames: 30,
      renderRange: async (range, attempt) => {
        calls.push(range);
        expect(attempt).toBe(1);
        return `segment-${range.rangeIndex}`;
      },
    });

    const segments = await handle.result;
    expect(segments).toEqual(["segment-0", "segment-1", "segment-2"]);
    expect(calls.map((r) => r.rangeIndex)).toEqual(expect.arrayContaining([0, 1, 2]));
  });

  it("resolves immediately to an empty array for a durationInFrames of 0 (vacuously done)", async () => {
    const project = buildProject(0);
    const renderRange = vi.fn(alwaysSucceeds());

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 0,
      renderRange,
    });

    await expect(handle.result).resolves.toEqual([]);
    expect(renderRange).not.toHaveBeenCalled();
    expect(getRenderJobStatus(handle.jobId).status).toBe("done");
  });

  it("respects maxConcurrency: never runs more ranges at once than the configured limit", async () => {
    const project = buildProject(120);
    let running = 0;
    let maxObservedRunning = 0;
    const pendingResolves: Array<() => void> = [];

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 120,
      rangeSizeFrames: 30,
      rangeAlignmentFrames: 30,
      maxConcurrency: 2,
      renderRange: (range) =>
        new Promise<string>((resolve) => {
          running += 1;
          maxObservedRunning = Math.max(maxObservedRunning, running);
          pendingResolves.push(() => {
            running -= 1;
            resolve(`segment-${range.rangeIndex}`);
          });
        }),
    });

    // Exactly 2 of the 4 ranges (120 frames / 30-frame ranges) may start at
    // once; the other 2 stay queued behind the concurrency limit.
    await vi.waitFor(() => expect(pendingResolves.length).toBe(2));
    expect(running).toBe(2);
    expect(maxObservedRunning).toBe(2);

    // Release the first 2; this frees exactly 2 slots, which the remaining
    // 2 queued ranges take (never more than 2 concurrently, at any point).
    pendingResolves.shift()?.();
    pendingResolves.shift()?.();
    await vi.waitFor(() => expect(pendingResolves.length).toBe(2));
    expect(maxObservedRunning).toBe(2);

    pendingResolves.shift()?.();
    pendingResolves.shift()?.();

    await handle.result;
    expect(maxObservedRunning).toBe(2);
  });

  it("reports incremental status via onStatusChange as ranges progress", async () => {
    const project = buildProject(60);
    const snapshots: RenderJobStatusSnapshot<string>[] = [];

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 60,
      rangeSizeFrames: 30,
      rangeAlignmentFrames: 30,
      maxConcurrency: 1,
      renderRange: alwaysSucceeds(),
      onStatusChange: (status) => snapshots.push(status),
    });

    await handle.result;

    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots[snapshots.length - 1]?.status).toBe("done");
    expect(snapshots[snapshots.length - 1]?.framesCompleted).toBe(60);
    // Status only ever moves forward for a single range: pending -> running
    // -> done, never backward, across the whole sequence of snapshots.
    const rank = { pending: 0, running: 1, done: 2, failed: 2 } as const;
    for (const range of [0, 1]) {
      let lastRank = -1;
      for (const snapshot of snapshots) {
        const rangeState = snapshot.ranges.find((r) => r.range.rangeIndex === range);
        if (rangeState === undefined) continue;
        expect(rank[rangeState.status]).toBeGreaterThanOrEqual(lastRank);
        lastRank = rank[rangeState.status];
      }
    }
  });

  it("defaults maxConcurrency/maxAttemptsPerRange/rangeSizeFrames/rangeAlignmentFrames when not supplied", async () => {
    expect(DEFAULT_MAX_CONCURRENCY).toBeGreaterThan(0);
    expect(DEFAULT_MAX_ATTEMPTS_PER_RANGE).toBeGreaterThan(1);

    const project = buildProject(10);
    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 10,
      renderRange: alwaysSucceeds(),
    });

    await expect(handle.result).resolves.toEqual(["segment-0"]);
  });
});

describe("submitRenderJob: per-range retry", () => {
  it("retries a failing range up to maxAttemptsPerRange, succeeding if a later attempt works", async () => {
    const project = buildProject(30);
    let attemptCount = 0;

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 30,
      maxAttemptsPerRange: 3,
      renderRange: async () => {
        attemptCount += 1;
        if (attemptCount < 3) {
          throw new Error(`transient failure ${attemptCount}`);
        }
        return "segment-0";
      },
    });

    await expect(handle.result).resolves.toEqual(["segment-0"]);
    expect(attemptCount).toBe(3);

    const status = getRenderJobStatus(handle.jobId);
    expect(status.status).toBe("done");
    expect(status.ranges[0]?.attempts).toBe(3);
    expect(status.ranges[0]?.errors).toHaveLength(2);
  });

  it("marks a range permanently failed after exhausting maxAttemptsPerRange, and rejects handle.result with RenderJobFailedError", async () => {
    const project = buildProject(30);

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 30,
      maxAttemptsPerRange: 2,
      renderRange: async () => {
        throw new Error("permanent failure");
      },
    });

    await expect(handle.result).rejects.toThrow(RenderJobFailedError);

    const status = getRenderJobStatus(handle.jobId);
    expect(status.status).toBe("failed");
    expect(status.ranges[0]?.status).toBe("failed");
    expect(status.ranges[0]?.attempts).toBe(2);
    expect(status.ranges[0]?.errors.map((e) => e.message)).toEqual([
      "permanent failure",
      "permanent failure",
    ]);
  });

  it("lets every other range finish (successfully or not) even after one range permanently fails, never cancelling in-flight siblings", async () => {
    const project = buildProject(90);
    const completedRanges: number[] = [];

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 90,
      rangeSizeFrames: 30,
      rangeAlignmentFrames: 30,
      maxConcurrency: 3,
      maxAttemptsPerRange: 1,
      renderRange: async (range) => {
        if (range.rangeIndex === 1) {
          throw new Error("range 1 always fails");
        }
        completedRanges.push(range.rangeIndex);
        return `segment-${range.rangeIndex}`;
      },
    });

    await expect(handle.result).rejects.toThrow(RenderJobFailedError);
    expect(completedRanges.sort()).toEqual([0, 2]);

    const status = getRenderJobStatus(handle.jobId);
    expect(status.ranges.find((r) => r.range.rangeIndex === 0)?.status).toBe("done");
    expect(status.ranges.find((r) => r.range.rangeIndex === 1)?.status).toBe("failed");
    expect(status.ranges.find((r) => r.range.rangeIndex === 2)?.status).toBe("done");
  });

  it("RenderJobFailedError lists every permanently-failed range's own bounds and error history", async () => {
    const project = buildProject(30);

    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 30,
      maxAttemptsPerRange: 1,
      renderRange: async () => {
        throw new Error("range died");
      },
    });

    try {
      await handle.result;
      expect.unreachable("handle.result should have rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderJobFailedError);
      const failedError = error as RenderJobFailedError;
      expect(failedError.failedRanges).toHaveLength(1);
      expect(failedError.failedRanges[0]?.range).toEqual({
        rangeIndex: 0,
        startFrame: 0,
        endFrame: 30,
      });
      expect(failedError.message).toContain("range died");
    }
  });
});

describe("getRenderJobStatus", () => {
  it("throws RenderJobNotFoundError for an unknown jobId", () => {
    expect(() => getRenderJobStatus("does-not-exist")).toThrow(RenderJobNotFoundError);
  });

  it("returns a live-queryable status by jobId alone, without retaining the original handle object", async () => {
    const project = buildProject(30);
    const handle = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 30,
      renderRange: alwaysSucceeds(),
    });
    const { jobId } = handle;

    await handle.result;

    // Query using only the jobId string, simulating a caller (e.g. a later
    // MCP/API layer) that persisted just the id, not the handle itself.
    const status = getRenderJobStatus(jobId);
    expect(status.status).toBe("done");
  });
});

describe("resumeRenderJob", () => {
  it("does not re-render ranges already marked done, only re-attempts pending/failed ones", async () => {
    const project = buildProject(90);
    const previousRanges: RangeState<string>[] = [
      {
        range: { rangeIndex: 0, startFrame: 0, endFrame: 30 },
        status: "done",
        attempts: 1,
        errors: [],
        segment: "segment-0-from-before",
      },
      {
        range: { rangeIndex: 1, startFrame: 30, endFrame: 60 },
        status: "failed",
        attempts: 2,
        errors: [new Error("earlier failure")],
      },
      {
        range: { rangeIndex: 2, startFrame: 60, endFrame: 90 },
        status: "pending",
        attempts: 0,
        errors: [],
      },
    ];
    const renderedRanges: number[] = [];

    const handle = resumeRenderJob(previousRanges, {
      project,
      compositionId: "comp-1",
      renderRange: async (range) => {
        renderedRanges.push(range.rangeIndex);
        return `segment-${range.rangeIndex}-resumed`;
      },
    });

    const segments = await handle.result;

    // Range 0 was never re-rendered; its already-succeeded segment is
    // reused verbatim.
    expect(renderedRanges.sort()).toEqual([1, 2]);
    expect(segments).toEqual(["segment-0-from-before", "segment-1-resumed", "segment-2-resumed"]);
  });

  it("preserves a resumed range's prior attempts count, continuing to count toward the same maxAttemptsPerRange budget", async () => {
    const project = buildProject(30);
    const previousRanges: RangeState<string>[] = [
      {
        range: { rangeIndex: 0, startFrame: 0, endFrame: 30 },
        status: "failed",
        attempts: 2,
        errors: [new Error("attempt 1 failed"), new Error("attempt 2 failed")],
      },
    ];

    const handle = resumeRenderJob(previousRanges, {
      project,
      compositionId: "comp-1",
      maxAttemptsPerRange: 3,
      renderRange: async () => {
        throw new Error("attempt 3 failed too");
      },
    });

    await expect(handle.result).rejects.toThrow(RenderJobFailedError);
    const status = getRenderJobStatus(handle.jobId);
    // Only one further attempt (attempt 3) should have run, since 2 were
    // already recorded from the previous run and maxAttemptsPerRange is 3.
    expect(status.ranges[0]?.attempts).toBe(3);
    expect(status.ranges[0]?.errors).toHaveLength(3);
  });

  it("treats a resumed 'running' range (its owning process exited mid-attempt) as needing a fresh attempt", async () => {
    const project = buildProject(30);
    const previousRanges: RangeState<string>[] = [
      {
        range: { rangeIndex: 0, startFrame: 0, endFrame: 30 },
        status: "running",
        attempts: 1,
        errors: [],
      },
    ];

    const handle = resumeRenderJob(previousRanges, {
      project,
      compositionId: "comp-1",
      renderRange: async () => "segment-0-recovered",
    });

    await expect(handle.result).resolves.toEqual(["segment-0-recovered"]);
  });

  it("succeeds trivially when every range in the snapshot is already done", async () => {
    const project = buildProject(30);
    const previousRanges: RangeState<string>[] = [
      {
        range: { rangeIndex: 0, startFrame: 0, endFrame: 30 },
        status: "done",
        attempts: 1,
        errors: [],
        segment: "already-done",
      },
    ];
    const renderRange = vi.fn(alwaysSucceeds());

    const handle = resumeRenderJob(previousRanges, {
      project,
      compositionId: "comp-1",
      renderRange,
    });

    await expect(handle.result).resolves.toEqual(["already-done"]);
    expect(renderRange).not.toHaveBeenCalled();
  });

  it("assigns a fresh jobId distinct from whatever job the snapshot originally came from", async () => {
    const project = buildProject(30);
    const original = submitRenderJob({
      project,
      compositionId: "comp-1",
      durationInFrames: 30,
      renderRange: async () => {
        throw new Error("fails");
      },
      maxAttemptsPerRange: 1,
    });
    await expect(original.result).rejects.toThrow(RenderJobFailedError);
    const snapshot = getRenderJobStatus<string>(original.jobId);

    const resumed = resumeRenderJob(snapshot.ranges, {
      project,
      compositionId: "comp-1",
      renderRange: alwaysSucceeds(),
    });

    expect(resumed.jobId).not.toBe(original.jobId);
    await expect(resumed.result).resolves.toEqual(["segment-0"]);
  });
});
