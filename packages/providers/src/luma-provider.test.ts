import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fetch-like.js";
import { createLumaProvider } from "./luma-provider.js";
import type { VideoGenerationRequest } from "./video-provider.js";

/** Builds a bare-bones JSON `Response`, mirroring Luma's own real response shape for a given fixture. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A teddy bear in sunglasses playing electric guitar and dancing.",
  params: { durationSeconds: 5, aspectRatio: "16:9" },
};

describe("createLumaProvider", () => {
  describe("submit", () => {
    it("posts to /generations/video with the expected body and headers", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe("https://api.lumalabs.ai/dream-machine/v1/generations/video");
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          prompt: BASE_REQUEST.prompt,
          model: "ray-2",
          aspect_ratio: "16:9",
          duration: "5s",
        });
        return jsonResponse(201, { id: "gen-abc", state: "queued", model: "ray-2" });
      });

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      const job = await provider.submit(BASE_REQUEST);

      expect(job).toEqual({ provider: "luma", externalJobId: "gen-abc" });
    });

    it("maps a durationSeconds above the 7s threshold to the 9s enum value", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(201, { id: "gen-1", state: "queued" });
      });

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { durationSeconds: 9 } });

      expect(capturedBody.duration).toBe("9s");
    });

    it("maps a single referenceImageUrls entry to keyframes.frame0 only", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(201, { id: "gen-i2v", state: "queued" });
      });

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, referenceImageUrls: ["https://example.test/start.jpg"] });

      expect(capturedBody.keyframes).toEqual({
        frame0: { type: "image", url: "https://example.test/start.jpg" },
      });
    });

    it("maps two referenceImageUrls entries to keyframes.frame0 and frame1", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(201, { id: "gen-interp", state: "queued" });
      });

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({
        ...BASE_REQUEST,
        referenceImageUrls: ["https://example.test/start.jpg", "https://example.test/end.jpg", "https://example.test/ignored.jpg"],
      });

      expect(capturedBody.keyframes).toEqual({
        frame0: { type: "image", url: "https://example.test/start.jpg" },
        frame1: { type: "image", url: "https://example.test/end.jpg" },
      });
    });

    it("drops seed entirely, since Luma does not support it", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(201, { id: "gen-1", state: "queued" });
      });

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { ...BASE_REQUEST.params, seed: 42 } });

      expect(capturedBody.seed).toBeUndefined();
    });

    it("omits aspect_ratio when given an unrecognized value, falling back to Luma's own default", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(201, { id: "gen-1", state: "queued" });
      });

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ ...BASE_REQUEST, params: { aspectRatio: "2.39:1" } });

      expect(capturedBody.aspect_ratio).toBeUndefined();
    });

    it("throws a descriptive error on a non-retryable failure response", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(400, { detail: "Prompt is too short, minimum length is 3 characters" }),
      );

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });

      await expect(provider.submit(BASE_REQUEST)).rejects.toThrow(
        "Luma submit failed: Prompt is too short, minimum length is 3 characters",
      );
    });

    it("retries a 429 rate-limit response and succeeds once Luma recovers", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 3) {
          return jsonResponse(429, { detail: "rate limited" });
        }
        return jsonResponse(201, { id: "gen-after-retry", state: "queued" });
      });

      const provider = createLumaProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const job = await provider.submit(BASE_REQUEST);

      expect(job.externalJobId).toBe("gen-after-retry");
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  describe("poll", () => {
    it("maps queued and dreaming to pending/running statuses", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        expect(input).toBe("https://api.lumalabs.ai/dream-machine/v1/generations/gen-abc");
        return jsonResponse(200, { id: "gen-abc", state: "dreaming" });
      });

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "luma", externalJobId: "gen-abc" });

      expect(status).toEqual({ status: "running" });
    });

    it("maps completed to a succeeded status with assets.video", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          id: "gen-abc",
          state: "completed",
          assets: { video: "https://storage.cdn.lumalabs.ai/output.mp4" },
        }),
      );

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "luma", externalJobId: "gen-abc" });

      expect(status).toEqual({
        status: "succeeded",
        outputUrl: "https://storage.cdn.lumalabs.ai/output.mp4",
      });
    });

    it("maps failed to a failed status using failure_reason", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, { id: "gen-abc", state: "failed", failure_reason: "Frame moderation failed" }),
      );

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "luma", externalJobId: "gen-abc" });

      expect(status).toEqual({ status: "failed", error: "Frame moderation failed" });
    });

    it("retries a 503 server error while polling and eventually succeeds", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 2) {
          return jsonResponse(503, { detail: "server error" });
        }
        return jsonResponse(200, { id: "gen-abc", state: "dreaming" });
      });

      const provider = createLumaProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const status = await provider.poll({ provider: "luma", externalJobId: "gen-abc" });

      expect(status).toEqual({ status: "running" });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("throws when the poll request itself fails with a non-retryable error", async () => {
      const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(404, { detail: "generation not found" }));

      const provider = createLumaProvider({ apiKey: "test-key", fetchFn });

      await expect(
        provider.poll({ provider: "luma", externalJobId: "missing-gen" }),
      ).rejects.toThrow("Luma poll failed: generation not found");
    });
  });

  it("exposes the provider name 'luma'", () => {
    const provider = createLumaProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("luma");
  });
});
