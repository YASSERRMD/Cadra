import type { RangeState, RenderJobStatusSnapshot } from "@cadra/headless";
import { describe, expect, it } from "vitest";

import {
  getRenderJobRecord,
  mintRenderJobId,
  registerRenderJob,
  resolveRenderOutputPath,
  serializeJobStatus,
  setRenderJobOutcome,
  trackRenderJobOutcome,
} from "./render-store.js";

describe("mintRenderJobId", () => {
  it("mints an id matching the allow-listed job id shape", () => {
    const jobId = mintRenderJobId();
    expect(jobId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jobId.startsWith("render-")).toBe(true);
  });

  it("mints distinct ids across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => mintRenderJobId()));
    expect(ids.size).toBe(20);
  });
});

describe("resolveRenderOutputPath", () => {
  it("resolves a well-formed job id to a path directly under the output directory", () => {
    const path = resolveRenderOutputPath("/workspace/out", "render-abc123", "mp4");
    expect(path).toBe("/workspace/out/render-abc123.mp4");
  });

  it("resolves with the webm extension when given", () => {
    const path = resolveRenderOutputPath("/workspace/out", "render-abc123", "webm");
    expect(path).toBe("/workspace/out/render-abc123.webm");
  });

  it("throws for a job id containing a path separator", () => {
    expect(() => resolveRenderOutputPath("/workspace/out", "../escape", "mp4")).toThrow();
    expect(() => resolveRenderOutputPath("/workspace/out", "foo/bar", "mp4")).toThrow();
  });

  it("throws for a job id containing '..'", () => {
    expect(() => resolveRenderOutputPath("/workspace/out", "render-..-abc", "mp4")).toThrow();
  });

  it("throws for an absolute-path-shaped job id", () => {
    expect(() => resolveRenderOutputPath("/workspace/out", "/etc/passwd", "mp4")).toThrow();
  });
});

describe("render job registry", () => {
  it("returns undefined for a job id that was never registered", () => {
    expect(getRenderJobRecord(`unregistered-${mintRenderJobId()}`)).toBeUndefined();
  });

  it("registers and retrieves a job record by its own job id", () => {
    const jobId = mintRenderJobId();
    registerRenderJob({
      jobId,
      encodedJobId: "encoded-1",
      sceneId: "scene-1",
      compositionId: "comp-1",
      format: "mp4",
      outputPath: "/workspace/out/render-1.mp4",
      submittedAt: new Date().toISOString(),
    });

    const record = getRenderJobRecord(jobId);
    expect(record).toBeDefined();
    expect(record?.sceneId).toBe("scene-1");
    expect(record?.compositionId).toBe("comp-1");
    expect(record?.format).toBe("mp4");
    expect(record?.outcome).toBeUndefined();
  });

  it("setRenderJobOutcome updates an existing record's outcome", () => {
    const jobId = mintRenderJobId();
    registerRenderJob({
      jobId,
      encodedJobId: "encoded-2",
      sceneId: "scene-1",
      compositionId: "comp-1",
      format: "mp4",
      outputPath: "/workspace/out/render-2.mp4",
      submittedAt: new Date().toISOString(),
    });

    setRenderJobOutcome(jobId, { ok: true });
    expect(getRenderJobRecord(jobId)?.outcome).toEqual({ ok: true });

    setRenderJobOutcome(jobId, { ok: false, message: "boom" });
    expect(getRenderJobRecord(jobId)?.outcome).toEqual({ ok: false, message: "boom" });
  });

  it("setRenderJobOutcome is a no-op for an unregistered job id", () => {
    expect(() => setRenderJobOutcome(`missing-${mintRenderJobId()}`, { ok: true })).not.toThrow();
  });

  it("trackRenderJobOutcome sets ok: true once the handle's result resolves", async () => {
    const jobId = mintRenderJobId();
    registerRenderJob({
      jobId,
      encodedJobId: "encoded-3",
      sceneId: "scene-1",
      compositionId: "comp-1",
      format: "mp4",
      outputPath: "/workspace/out/render-3.mp4",
      submittedAt: new Date().toISOString(),
    });

    trackRenderJobOutcome(jobId, { jobId: "encoded-3", result: Promise.resolve() });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getRenderJobRecord(jobId)?.outcome).toEqual({ ok: true });
  });

  it("trackRenderJobOutcome sets ok: false with the error's message once the handle's result rejects", async () => {
    const jobId = mintRenderJobId();
    registerRenderJob({
      jobId,
      encodedJobId: "encoded-4",
      sceneId: "scene-1",
      compositionId: "comp-1",
      format: "mp4",
      outputPath: "/workspace/out/render-4.mp4",
      submittedAt: new Date().toISOString(),
    });

    trackRenderJobOutcome(jobId, {
      jobId: "encoded-4",
      result: Promise.reject(new Error("range 0 permanently failed")),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getRenderJobRecord(jobId)?.outcome).toEqual({
      ok: false,
      message: "range 0 permanently failed",
    });
  });

  it("trackRenderJobOutcome stringifies a non-Error rejection", async () => {
    const jobId = mintRenderJobId();
    registerRenderJob({
      jobId,
      encodedJobId: "encoded-5",
      sceneId: "scene-1",
      compositionId: "comp-1",
      format: "mp4",
      outputPath: "/workspace/out/render-5.mp4",
      submittedAt: new Date().toISOString(),
    });

    trackRenderJobOutcome(jobId, { jobId: "encoded-5", result: Promise.reject("plain string error") });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getRenderJobRecord(jobId)?.outcome).toEqual({ ok: false, message: "plain string error" });
  });
});

describe("serializeJobStatus", () => {
  it("serializes a snapshot with no ranges", () => {
    const snapshot: RenderJobStatusSnapshot<unknown> = {
      status: "done",
      ranges: [],
      totalFrames: 0,
      framesCompleted: 0,
    };

    expect(serializeJobStatus(snapshot)).toEqual({
      status: "done",
      totalFrames: 0,
      framesCompleted: 0,
      ranges: [],
    });
  });

  it("serializes range errors to plain { message } objects instead of dropping them", () => {
    const range: RangeState<unknown> = {
      range: { rangeIndex: 0, startFrame: 0, endFrame: 6 },
      status: "failed",
      attempts: 3,
      errors: [new Error("attempt 1 failed"), new Error("attempt 2 failed")],
    };
    const snapshot: RenderJobStatusSnapshot<unknown> = {
      status: "failed",
      ranges: [range],
      totalFrames: 6,
      framesCompleted: 0,
    };

    const serialized = serializeJobStatus(snapshot);

    // A plain JSON.stringify(new Error(...)) would produce "{}", silently
    // dropping the message; this is exactly what serializeJobStatus must
    // avoid.
    expect(serialized.ranges[0]?.errors).toEqual([
      { message: "attempt 1 failed" },
      { message: "attempt 2 failed" },
    ]);
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });

  it("omits each range's opaque segment data, carrying only status metadata", () => {
    const range: RangeState<{ big: string }> = {
      range: { rangeIndex: 0, startFrame: 0, endFrame: 6 },
      status: "done",
      attempts: 1,
      segment: { big: "this should not appear in the serialized status" },
      errors: [],
    };
    const snapshot: RenderJobStatusSnapshot<{ big: string }> = {
      status: "done",
      ranges: [range],
      totalFrames: 6,
      framesCompleted: 6,
    };

    const serialized = serializeJobStatus(snapshot);
    expect(serialized.ranges[0]).toEqual({
      range: { rangeIndex: 0, startFrame: 0, endFrame: 6 },
      status: "done",
      attempts: 1,
      errors: [],
    });
    expect(JSON.stringify(serialized)).not.toContain("this should not appear");
  });

  it("preserves totalFrames/framesCompleted/status verbatim", () => {
    const snapshot: RenderJobStatusSnapshot<unknown> = {
      status: "running",
      ranges: [
        { range: { rangeIndex: 0, startFrame: 0, endFrame: 6 }, status: "done", attempts: 1, errors: [] },
        { range: { rangeIndex: 1, startFrame: 6, endFrame: 12 }, status: "running", attempts: 1, errors: [] },
      ],
      totalFrames: 12,
      framesCompleted: 6,
    };

    const serialized = serializeJobStatus(snapshot);
    expect(serialized.status).toBe("running");
    expect(serialized.totalFrames).toBe(12);
    expect(serialized.framesCompleted).toBe(6);
    expect(serialized.ranges).toHaveLength(2);
  });
});
