import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fetch-like.js";
import { createPikaProvider } from "./pika-provider.js";
import type { VideoGenerationRequest } from "./video-provider.js";

/** Builds a bare-bones JSON `Response`, mirroring fal.ai's own real response shape for a given fixture. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A hot air balloon drifting over a lavender field.",
  params: { durationSeconds: 5, aspectRatio: "16:9" },
};

describe("createPikaProvider", () => {
  describe("submit", () => {
    it("posts to the text-to-video endpoint with no reference image, using fal's Key auth scheme", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe("https://queue.fal.run/fal-ai/pika/v2.2/text-to-video");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: "Key test-key" });
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({ prompt: BASE_REQUEST.prompt, duration: "5", aspect_ratio: "16:9" });
        return jsonResponse(200, { request_id: "req-abc" });
      });

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      const job = await provider.submit(BASE_REQUEST);

      expect(job).toEqual({ provider: "pika", externalJobId: "text-to-video:req-abc" });
    });

    it("posts to the image-to-video endpoint with image_url and no aspect_ratio when a reference image is given", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe("https://queue.fal.run/fal-ai/pika/v2.2/image-to-video");
        const body = JSON.parse(init?.body as string);
        expect(body.image_url).toBe("https://example.test/frame.png");
        expect(body.aspect_ratio).toBeUndefined();
        return jsonResponse(200, { request_id: "req-i2v" });
      });

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      const job = await provider.submit({
        ...BASE_REQUEST,
        referenceImageUrls: ["https://example.test/frame.png"],
      });

      expect(job.externalJobId).toBe("image-to-video:req-i2v");
    });

    it("maps a durationSeconds above the 7s threshold to the '10' enum value", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { request_id: "req-1" });
      });

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { durationSeconds: 10 } });

      expect(capturedBody.duration).toBe("10");
    });

    it("passes seed through when provided", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { request_id: "req-1" });
      });

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { ...BASE_REQUEST.params, seed: 123 } });

      expect(capturedBody.seed).toBe(123);
    });

    it("throws a descriptive error on a non-retryable failure response", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(422, { detail: "prompt field is required" }),
      );

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });

      await expect(provider.submit(BASE_REQUEST)).rejects.toThrow(
        "Pika (via fal.ai) submit failed: prompt field is required",
      );
    });

    it("retries a 429 rate-limit response and succeeds once fal recovers", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 3) {
          return jsonResponse(429, { detail: "concurrency limit exceeded" });
        }
        return jsonResponse(200, { request_id: "req-after-retry" });
      });

      const provider = createPikaProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const job = await provider.submit(BASE_REQUEST);

      expect(job.externalJobId).toBe("text-to-video:req-after-retry");
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  describe("poll", () => {
    it("maps IN_QUEUE and IN_PROGRESS to pending/running statuses", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        expect(input).toBe(
          "https://queue.fal.run/fal-ai/pika/v2.2/text-to-video/requests/req-abc/status",
        );
        return jsonResponse(200, { status: "IN_QUEUE" });
      });

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "pika", externalJobId: "text-to-video:req-abc" });

      expect(status).toEqual({ status: "pending" });
    });

    it("fetches the result endpoint and maps to succeeded once COMPLETED with no error", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        if ((input as string).endsWith("/status")) {
          return jsonResponse(200, { status: "COMPLETED", error: null });
        }
        expect(input).toBe("https://queue.fal.run/fal-ai/pika/v2.2/text-to-video/requests/req-abc");
        return jsonResponse(200, { video: { url: "https://cdn.fal.test/output.mp4" } });
      });

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "pika", externalJobId: "text-to-video:req-abc" });

      expect(status).toEqual({ status: "succeeded", outputUrl: "https://cdn.fal.test/output.mp4" });
    });

    it("maps a COMPLETED queue status with a populated error field to a failed status", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, { status: "COMPLETED", error: "Content policy violation", error_type: "SAFETY" }),
      );

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "pika", externalJobId: "text-to-video:req-abc" });

      expect(status).toEqual({ status: "failed", error: "Content policy violation (SAFETY)" });
    });

    it("polls the image-to-video request path when the job was submitted as image-to-video", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        expect(input).toContain("/fal-ai/pika/v2.2/image-to-video/requests/req-i2v");
        if ((input as string).endsWith("/status")) {
          return jsonResponse(200, { status: "COMPLETED", error: null });
        }
        return jsonResponse(200, { video: { url: "https://cdn.fal.test/i2v-output.mp4" } });
      });

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "pika", externalJobId: "image-to-video:req-i2v" });

      expect(status).toEqual({ status: "succeeded", outputUrl: "https://cdn.fal.test/i2v-output.mp4" });
    });

    it("retries a 500 server error while polling and eventually succeeds", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        if ((input as string).endsWith("/status")) {
          calls += 1;
          if (calls < 2) {
            return jsonResponse(500, { detail: "server error" });
          }
          return jsonResponse(200, { status: "IN_PROGRESS" });
        }
        return jsonResponse(200, {});
      });

      const provider = createPikaProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const status = await provider.poll({ provider: "pika", externalJobId: "text-to-video:req-abc" });

      expect(status).toEqual({ status: "running" });
      expect(calls).toBe(2);
    });

    it("returns a failed status for a malformed externalJobId with no endpoint prefix", async () => {
      const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(200, {}));

      const provider = createPikaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "pika", externalJobId: "req-with-no-prefix" });

      expect(status.status).toBe("failed");
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  it("exposes the provider name 'pika'", () => {
    const provider = createPikaProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("pika");
  });
});
