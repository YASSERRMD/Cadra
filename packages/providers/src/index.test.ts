import { describe, expect, it, vi } from "vitest";

import {
  createKlingProvider,
  createLumaProvider,
  createPikaProvider,
  createRunwayProvider,
  createVeoProvider,
  type FetchLike,
  PACKAGE_NAME,
  VERSION,
  type VideoGenerationRequest,
  type VideoProvider,
} from "./index.js";

describe("@cadra/providers", () => {
  it("exports the expected VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the expected PACKAGE_NAME", () => {
    expect(PACKAGE_NAME).toBe("@cadra/providers");
  });

  it("re-exports a factory for every one of this phase's five vendors, each with the expected provider name", () => {
    const fetchFn: FetchLike = vi.fn(async () => new Response("{}", { status: 200 }));

    const providers: VideoProvider[] = [
      createVeoProvider({ apiKey: "k", fetchFn }),
      createRunwayProvider({ apiKey: "k", fetchFn }),
      createKlingProvider({ accessKey: "ak", secretKey: "sk", fetchFn }),
      createLumaProvider({ apiKey: "k", fetchFn }),
      createPikaProvider({ apiKey: "k", fetchFn }),
    ];

    expect(providers.map((p) => p.name)).toEqual(["veo", "runway", "kling", "luma", "pika"]);
  });

  it("demonstrates providers are swappable behind one VideoProvider interface: the same request shape and calling code works against every adapter", async () => {
    const request: VideoGenerationRequest = {
      prompt: "A lighthouse beam sweeping across a stormy sea.",
      params: { durationSeconds: 5, aspectRatio: "16:9" },
    };

    /** Exercises a VideoProvider purely through the interface, with no vendor-specific branching at all: this is the acceptance criterion "providers are swappable" made concrete. */
    async function submitAndDescribe(provider: VideoProvider, req: VideoGenerationRequest): Promise<string> {
      const job = await provider.submit(req);
      return `${job.provider}:${job.externalJobId}`;
    }

    const veoFetch: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ name: "operations/veo-job", done: false }), { status: 200 }),
    );
    const runwayFetch: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ id: "runway-job" }), { status: 200 }),
    );
    const klingFetch: FetchLike = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 0, message: "success", request_id: "r1", data: { task_id: "kling-job" } }),
        { status: 200 },
      ),
    );
    const lumaFetch: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ id: "luma-job", state: "queued" }), { status: 200 }),
    );
    const pikaFetch: FetchLike = vi.fn(async () =>
      new Response(JSON.stringify({ request_id: "pika-job" }), { status: 200 }),
    );

    const results = await Promise.all([
      submitAndDescribe(createVeoProvider({ apiKey: "k", fetchFn: veoFetch }), request),
      submitAndDescribe(createRunwayProvider({ apiKey: "k", fetchFn: runwayFetch }), request),
      submitAndDescribe(
        createKlingProvider({ accessKey: "ak", secretKey: "sk", fetchFn: klingFetch }),
        request,
      ),
      submitAndDescribe(createLumaProvider({ apiKey: "k", fetchFn: lumaFetch }), request),
      submitAndDescribe(createPikaProvider({ apiKey: "k", fetchFn: pikaFetch }), request),
    ]);

    expect(results).toEqual([
      "veo:operations/veo-job",
      "runway:runway-job",
      "kling:kling-job",
      "luma:luma-job",
      "pika:text-to-video:pika-job",
    ]);
  });
});
