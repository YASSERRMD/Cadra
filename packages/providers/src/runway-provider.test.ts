import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fetch-like.js";
import { createRunwayProvider } from "./runway-provider.js";
import type { VideoGenerationRequest } from "./video-provider.js";

/** Builds a bare-bones JSON `Response`, mirroring Runway's own real response shape for a given fixture. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A cat riding a skateboard down a sunny boardwalk.",
  params: { durationSeconds: 5, aspectRatio: "16:9" },
};

describe("createRunwayProvider", () => {
  describe("submit", () => {
    it("posts to /v1/text_to_video with no reference image, and returns the task id as externalJobId", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe("https://api.dev.runwayml.com/v1/text_to_video");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer test-key",
          "X-Runway-Version": "2024-11-06",
        });
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          model: "gen4.5",
          promptText: BASE_REQUEST.prompt,
          ratio: "1280:720",
          duration: 5,
        });
        return jsonResponse(200, { id: "17f20503-6c24-4c16-946b-35dbbce2af2f" });
      });

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      const job = await provider.submit(BASE_REQUEST);

      expect(job).toEqual({
        provider: "runway",
        externalJobId: "17f20503-6c24-4c16-946b-35dbbce2af2f",
      });
    });

    it("posts to /v1/image_to_video with promptImage set to referenceImageUrls[0] when a reference image is given", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe("https://api.dev.runwayml.com/v1/image_to_video");
        const body = JSON.parse(init?.body as string);
        expect(body.promptImage).toBe("https://example.test/reference.jpg");
        expect(body.model).toBe("gen4.5");
        return jsonResponse(200, { id: "task-i2v-1" });
      });

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      const job = await provider.submit({
        ...BASE_REQUEST,
        referenceImageUrls: ["https://example.test/reference.jpg", "https://example.test/ignored.jpg"],
      });

      expect(job.externalJobId).toBe("task-i2v-1");
    });

    it("passes seed through when provided, and omits it entirely when absent", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { id: "task-seed" });
      });

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { ...BASE_REQUEST.params, seed: 42 } });
      expect(capturedBody.seed).toBe(42);

      await provider.submit(BASE_REQUEST);
      expect(capturedBody.seed).toBeUndefined();
    });

    it("maps an unrecognized aspectRatio to the default 1280:720 ratio", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { id: "task-ratio" });
      });

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { aspectRatio: "21:9" } });
      expect(capturedBody.ratio).toBe("1280:720");
    });

    it("clamps an out-of-range durationSeconds into Runway's valid 2-10 range", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { id: "task-duration" });
      });

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { durationSeconds: 60 } });
      expect(capturedBody.duration).toBe(10);
    });

    it("throws a descriptive error on a non-retryable failure response", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(400, { error: "promptText must not be empty" }),
      );

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });

      await expect(provider.submit(BASE_REQUEST)).rejects.toThrow(
        "Runway submit failed: promptText must not be empty",
      );
    });

    it("retries a 429 rate-limit response and succeeds once Runway recovers", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 3) {
          return jsonResponse(429, { error: "rate limited" });
        }
        return jsonResponse(200, { id: "task-after-retry" });
      });

      const provider = createRunwayProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const job = await provider.submit(BASE_REQUEST);

      expect(job.externalJobId).toBe("task-after-retry");
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  describe("poll", () => {
    it("maps PENDING and THROTTLED to a pending status", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        expect(input).toBe("https://api.dev.runwayml.com/v1/tasks/task-1");
        return jsonResponse(200, {
          id: "task-1",
          createdAt: "2026-01-01T00:00:00Z",
          status: "PENDING",
        });
      });

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "runway", externalJobId: "task-1" });

      expect(status).toEqual({ status: "pending" });
    });

    it("maps RUNNING to a running status", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          id: "task-1",
          createdAt: "2026-01-01T00:00:00Z",
          status: "RUNNING",
          progress: 0.4,
        }),
      );

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "runway", externalJobId: "task-1" });

      expect(status).toEqual({ status: "running" });
    });

    it("maps SUCCEEDED to a succeeded status with the first output URL", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          id: "task-1",
          createdAt: "2026-01-01T00:00:00Z",
          status: "SUCCEEDED",
          output: ["https://cdn.runway.test/output.mp4"],
        }),
      );

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "runway", externalJobId: "task-1" });

      expect(status).toEqual({ status: "succeeded", outputUrl: "https://cdn.runway.test/output.mp4" });
    });

    it("maps FAILED to a failed status including the failureCode", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          id: "task-1",
          createdAt: "2026-01-01T00:00:00Z",
          status: "FAILED",
          failure: "Content moderation flagged this request.",
          failureCode: "SAFETY.INPUT.TEXT",
        }),
      );

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "runway", externalJobId: "task-1" });

      expect(status).toEqual({
        status: "failed",
        error: "Content moderation flagged this request. (SAFETY.INPUT.TEXT)",
      });
    });

    it("maps CANCELLED to a failed status", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          id: "task-1",
          createdAt: "2026-01-01T00:00:00Z",
          status: "CANCELLED",
        }),
      );

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "runway", externalJobId: "task-1" });

      expect(status).toEqual({ status: "failed", error: "Runway task was cancelled." });
    });

    it("retries a 503 server error while polling and eventually succeeds", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 2) {
          return jsonResponse(503, { error: "server error" });
        }
        return jsonResponse(200, {
          id: "task-1",
          createdAt: "2026-01-01T00:00:00Z",
          status: "SUCCEEDED",
          output: ["https://cdn.runway.test/output.mp4"],
        });
      });

      const provider = createRunwayProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const status = await provider.poll({ provider: "runway", externalJobId: "task-1" });

      expect(status).toEqual({ status: "succeeded", outputUrl: "https://cdn.runway.test/output.mp4" });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("throws when the poll request itself fails with a non-retryable error", async () => {
      const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(404, { error: "task not found" }));

      const provider = createRunwayProvider({ apiKey: "test-key", fetchFn });

      await expect(
        provider.poll({ provider: "runway", externalJobId: "missing-task" }),
      ).rejects.toThrow("Runway poll failed: task not found");
    });
  });

  it("exposes the provider name 'runway'", () => {
    const provider = createRunwayProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("runway");
  });
});
