import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "./fetch-like.js";
import { createKlingProvider } from "./kling-provider.js";
import type { VideoGenerationRequest } from "./video-provider.js";

/** Builds a bare-bones JSON `Response`, mirroring Kling's own real response shape for a given fixture. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Decodes a base64url JWT segment back to its JSON payload, for asserting the exact claims this adapter signs. */
function decodeJwtSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A neon-lit cyberpunk street market at night.",
  params: { durationSeconds: 5, aspectRatio: "16:9" },
};

describe("createKlingProvider", () => {
  describe("submit", () => {
    it("posts to /v1/videos/text2video with no reference image, signing a JWT with the expected claims", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe("https://api-singapore.klingai.com/v1/videos/text2video");
        expect(init?.method).toBe("POST");

        const authHeader = (init?.headers as Record<string, string>).Authorization ?? "";
        expect(authHeader).toMatch(/^Bearer /);
        const jwt = authHeader.replace("Bearer ", "");
        const segments = jwt.split(".");
        expect(segments).toHaveLength(3);
        expect(decodeJwtSegment(segments[0] ?? "")).toEqual({ alg: "HS256", typ: "JWT" });
        expect(decodeJwtSegment(segments[1] ?? "")).toEqual({ iss: "test-ak", exp: 1800, nbf: -5 });

        const body = JSON.parse(init?.body as string);
        expect(body).toEqual({
          model_name: "kling-v2-master",
          prompt: BASE_REQUEST.prompt,
          duration: "5",
          aspect_ratio: "16:9",
        });
        return jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-1",
          data: { task_id: "task-abc" },
        });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      const job = await provider.submit(BASE_REQUEST);

      expect(job).toEqual({ provider: "kling", externalJobId: "task-abc" });
    });

    it("posts to /v1/videos/image2video with an image field and no aspect_ratio when a reference image is given", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input, init) => {
        expect(input).toBe("https://api-singapore.klingai.com/v1/videos/image2video");
        const body = JSON.parse(init?.body as string);
        expect(body.image).toBe("https://example.test/frame.jpg");
        expect(body.aspect_ratio).toBeUndefined();
        return jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-2",
          data: { task_id: "task-i2v" },
        });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      const job = await provider.submit({
        ...BASE_REQUEST,
        referenceImageUrls: ["https://example.test/frame.jpg"],
      });

      expect(job.externalJobId).toBe("task-i2v");
    });

    it("drops seed entirely, since Kling does not support it", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { code: 0, message: "success", request_id: "req-3", data: { task_id: "t" } });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      await provider.submit({ ...BASE_REQUEST, params: { ...BASE_REQUEST.params, seed: 99 } });

      expect(capturedBody.seed).toBeUndefined();
    });

    it("clamps an out-of-range durationSeconds into Kling's valid 3-15 range and stringifies it", async () => {
      let capturedBody: Record<string, unknown> = {};
      const fetchFn = vi.fn<FetchLike>(async (_input, init) => {
        capturedBody = JSON.parse(init?.body as string);
        return jsonResponse(200, { code: 0, message: "success", request_id: "req-4", data: { task_id: "t" } });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      await provider.submit({ ...BASE_REQUEST, params: { durationSeconds: 30 } });

      expect(capturedBody.duration).toBe("15");
    });

    it("throws a descriptive error on a non-retryable failure response", async () => {
      const fetchFn = vi.fn<FetchLike>(async () => jsonResponse(400, { code: 1200, message: "invalid params" }));

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });

      await expect(provider.submit(BASE_REQUEST)).rejects.toThrow("Kling submit failed: invalid params");
    });

    it("retries a 429 rate-limit response and succeeds once Kling recovers", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 3) {
          return jsonResponse(429, { code: 1303, message: "parallel task over resource pack limit" });
        }
        return jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-5",
          data: { task_id: "task-after-retry" },
        });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
        retryOptions: { sleepFn: async () => undefined },
      });
      const job = await provider.submit(BASE_REQUEST);

      expect(job.externalJobId).toBe("task-after-retry");
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });
  });

  describe("poll", () => {
    it("maps submitted and processing to pending/running statuses", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-1",
          data: { task_id: "task-1", task_status: "submitted" },
        }),
      );

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      const status = await provider.poll({ provider: "kling", externalJobId: "task-1" });

      expect(status).toEqual({ status: "pending" });
    });

    it("maps succeed to a succeeded status with the first video url", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        expect(input).toBe("https://api-singapore.klingai.com/v1/videos/text2video/task-1");
        return jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-1",
          data: {
            task_id: "task-1",
            task_status: "succeed",
            task_result: { videos: [{ id: "vid-1", url: "https://cdn.kling.test/output.mp4" }] },
          },
        });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      const status = await provider.poll({ provider: "kling", externalJobId: "task-1" });

      expect(status).toEqual({ status: "succeeded", outputUrl: "https://cdn.kling.test/output.mp4" });
    });

    it("maps failed to a failed status using task_status_msg", async () => {
      const fetchFn = vi.fn<FetchLike>(async () =>
        jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-1",
          data: { task_id: "task-1", task_status: "failed", task_status_msg: "Content policy violation." },
        }),
      );

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      const status = await provider.poll({ provider: "kling", externalJobId: "task-1" });

      expect(status).toEqual({ status: "failed", error: "Content policy violation." });
    });

    it("falls back to the image2video endpoint when the text2video lookup 404s", async () => {
      const fetchFn = vi.fn<FetchLike>(async (input) => {
        if (input === "https://api-singapore.klingai.com/v1/videos/text2video/task-i2v-1") {
          return jsonResponse(404, { code: 1203, message: "task not found" });
        }
        expect(input).toBe("https://api-singapore.klingai.com/v1/videos/image2video/task-i2v-1");
        return jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-1",
          data: {
            task_id: "task-i2v-1",
            task_status: "succeed",
            task_result: { videos: [{ id: "vid-1", url: "https://cdn.kling.test/i2v-output.mp4" }] },
          },
        });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
      });
      const status = await provider.poll({ provider: "kling", externalJobId: "task-i2v-1" });

      expect(status).toEqual({ status: "succeeded", outputUrl: "https://cdn.kling.test/i2v-output.mp4" });
    });

    it("retries a 500 server error while polling and eventually succeeds", async () => {
      let calls = 0;
      const fetchFn = vi.fn<FetchLike>(async () => {
        calls += 1;
        if (calls < 2) {
          return jsonResponse(500, { code: 5000, message: "server error" });
        }
        return jsonResponse(200, {
          code: 0,
          message: "success",
          request_id: "req-1",
          data: { task_id: "task-1", task_status: "processing" },
        });
      });

      const provider = createKlingProvider({
        accessKey: "test-ak",
        secretKey: "test-sk",
        fetchFn,
        nowInSeconds: () => 0,
        retryOptions: { sleepFn: async () => undefined },
      });
      const status = await provider.poll({ provider: "kling", externalJobId: "task-1" });

      expect(status).toEqual({ status: "running" });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  it("exposes the provider name 'kling'", () => {
    const provider = createKlingProvider({ accessKey: "ak", secretKey: "sk" });
    expect(provider.name).toBe("kling");
  });
});
