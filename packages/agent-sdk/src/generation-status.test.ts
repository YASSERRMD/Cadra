import type { VideoGenerationJob, VideoGenerationRequest, VideoGenerationStatus, VideoProvider } from "@cadra/providers";
import { describe, expect, it, vi } from "vitest";

import { createGenerationStore, getGenerationSlotStatus, UnknownSlotError } from "./generation-status.js";

/** A minimal, fully injectable fake `VideoProvider`, matching `@cadra/providers`'s own test fixtures: no real network call, ever. */
function createFakeProvider(name: string): {
  provider: VideoProvider;
  setNextStatus: (externalJobId: string, status: VideoGenerationStatus) => void;
} {
  const statusByJobId = new Map<string, VideoGenerationStatus>();
  let counter = 0;

  const provider: VideoProvider = {
    name,
    submit: vi.fn(async (_request: VideoGenerationRequest): Promise<VideoGenerationJob> => {
      counter += 1;
      const externalJobId = `${name}-job-${counter}`;
      statusByJobId.set(externalJobId, { status: "pending" });
      return { provider: name, externalJobId };
    }),
    poll: vi.fn(async (job: VideoGenerationJob): Promise<VideoGenerationStatus> => {
      return statusByJobId.get(job.externalJobId) ?? { status: "pending" };
    }),
  };

  return {
    provider,
    setNextStatus: (externalJobId, status) => statusByJobId.set(externalJobId, status),
  };
}

describe("getGenerationSlotStatus", () => {
  it("resolves a freshly submitted slot to a spinner placeholder", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });

    await store.submitGeneration("hero-clip", "veo", {
      prompt: "A sunrise over rolling hills.",
      params: { durationSeconds: 5 },
    });

    expect(getGenerationSlotStatus(store, "hero-clip")).toEqual({
      status: "pending",
      placeholder: { kind: "spinner" },
    });
  });

  it("resolves to ready with the vendor's outputUrl once the store observes success", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });

    await store.submitGeneration("hero-clip", "veo", {
      prompt: "A sunrise over rolling hills.",
      params: { durationSeconds: 5 },
    });
    fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: "https://vendor.example/hero.mp4" });
    await store.refresh();

    expect(getGenerationSlotStatus(store, "hero-clip")).toEqual({
      status: "ready",
      outputUrl: "https://vendor.example/hero.mp4",
    });
  });

  it("forwards placeholder preference options through to the underlying store", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });

    await store.submitGeneration("hero-clip", "veo", {
      prompt: "A sunrise over rolling hills.",
      params: { durationSeconds: 5 },
    });

    expect(getGenerationSlotStatus(store, "hero-clip", { prefer: "solid", solidColor: [1, 0, 0, 1] })).toEqual({
      status: "pending",
      placeholder: { kind: "solid", color: [1, 0, 0, 1] },
    });
  });

  it("throws UnknownSlotError for a slot id never submitted to the store", () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });

    expect(() => getGenerationSlotStatus(store, "no-such-slot")).toThrow(UnknownSlotError);
  });
});
