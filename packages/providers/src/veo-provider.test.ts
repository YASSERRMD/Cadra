import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fetch-like.js";
import { createVeoProvider } from "./veo-provider.js";
import type { VideoGenerationRequest } from "./video-provider.js";

/** Builds a bare-bones JSON `Response`, mirroring Google's own real response shape for a given fixture. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A drone shot over a misty mountain valley at sunrise.",
  params: { durationSeconds: 8, aspectRatio: "16:9", seed: 7 },
};

describe("createVeoProvider", () => {
  describe("submit", () => {
    it("posts to the predictLongRunning endpoint with the expected body and headers", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe(
          "https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
        );
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          instances: [{ prompt: BASE_REQUEST.prompt }],
          parameters: { aspectRatio: "16:9", durationSeconds: 8, seed: 7 },
        });
        return jsonResponse(200, {
          name: "models/veo-3.1-generate-preview/operations/op-123",
          done: false,
        });
      });

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });
      const job = await provider.submit(BASE_REQUEST);

      expect(job).toEqual({
        provider: "veo",
        externalJobId: "models/veo-3.1-generate-preview/operations/op-123",
      });
    });

    it("omits the parameters object entirely when params is empty", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { name: "operations/op-empty", done: false });
      });

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });
      await provider.submit({ prompt: "A simple prompt.", params: {} });

      expect(capturedBody).toEqual({ instances: [{ prompt: "A simple prompt." }] });
    });

    it("uses a caller-supplied model id instead of the default", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        expect(input).toBe(
          "https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predictLongRunning",
        );
        return jsonResponse(200, { name: "operations/op-custom-model", done: false });
      });

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn, model: "veo-2.0-generate-001" });
      await provider.submit(BASE_REQUEST);
    });

    it("throws a descriptive error when referenceImageUrls is given, since Veo needs inline base64 bytes not a URL", async () => {
      const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(200, {}));

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });

      await expect(
        provider.submit({ ...BASE_REQUEST, referenceImageUrls: ["https://example.test/frame.png"] }),
      ).rejects.toThrow("image-to-video is not supported by this adapter");
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("throws a descriptive error on a non-retryable failure response", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(400, { error: { code: 400, message: "Prompt violates content policy." } }),
      );

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });

      await expect(provider.submit(BASE_REQUEST)).rejects.toThrow(
        "Veo submit failed: Prompt violates content policy.",
      );
    });

    it("retries a 429 rate-limit response and succeeds once Veo recovers", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 3) {
          return jsonResponse(429, { error: { code: 429, message: "Resource exhausted" } });
        }
        return jsonResponse(200, { name: "operations/op-after-retry", done: false });
      });

      const provider = createVeoProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const job = await provider.submit(BASE_REQUEST);

      expect(job.externalJobId).toBe("operations/op-after-retry");
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  describe("poll", () => {
    it("maps done: false to a running status", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        expect(input).toBe("https://generativelanguage.googleapis.com/v1beta/operations/op-123");
        return jsonResponse(200, { name: "operations/op-123", done: false });
      });

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "veo", externalJobId: "operations/op-123" });

      expect(status).toEqual({ status: "running" });
    });

    it("maps a done operation with a generated sample to a succeeded status", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          name: "operations/op-123",
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [
                { video: { uri: "https://generativelanguage.googleapis.com/v1beta/files/abc.mp4" } },
              ],
            },
          },
        }),
      );

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "veo", externalJobId: "operations/op-123" });

      expect(status).toEqual({
        status: "succeeded",
        outputUrl: "https://generativelanguage.googleapis.com/v1beta/files/abc.mp4",
      });
    });

    it("maps a done operation with an error to a failed status", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          name: "operations/op-123",
          done: true,
          error: { code: 3, message: "Safety filter triggered." },
        }),
      );

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });
      const status = await provider.poll({ provider: "veo", externalJobId: "operations/op-123" });

      expect(status).toEqual({ status: "failed", error: "Safety filter triggered." });
    });

    it("retries a 503 server error while polling and eventually succeeds", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 2) {
          return jsonResponse(503, { error: { code: 503, message: "server error" } });
        }
        return jsonResponse(200, { name: "operations/op-123", done: false });
      });

      const provider = createVeoProvider({
        apiKey: "test-key",
        fetchFn,
        retryOptions: { sleepFn: async () => undefined },
      });
      const status = await provider.poll({ provider: "veo", externalJobId: "operations/op-123" });

      expect(status).toEqual({ status: "running" });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("throws when the poll request itself fails with a non-retryable error", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(404, { error: { code: 404, message: "Operation not found." } }),
      );

      const provider = createVeoProvider({ apiKey: "test-key", fetchFn });

      await expect(
        provider.poll({ provider: "veo", externalJobId: "operations/missing" }),
      ).rejects.toThrow("Veo poll failed: Operation not found.");
    });
  });

  it("exposes the provider name 'veo'", () => {
    const provider = createVeoProvider({ apiKey: "test-key" });
    expect(provider.name).toBe("veo");
  });
});
