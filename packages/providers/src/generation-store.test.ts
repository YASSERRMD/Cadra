import { describe, expect, it, vi } from "vitest";

import {
  createGenerationStore,
  UnknownProviderError,
  UnknownSlotError,
} from "./generation-store.js";
import type {
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "./video-provider.js";

/**
 * A minimal, fully injectable fake `VideoProvider` for this suite: `submit`
 * mints a sequential job id and records the call, `poll` returns whatever
 * `nextStatus` was last configured (or `{ status: "pending" }` by default),
 * matching every real adapter's `VideoProvider` shape with zero network
 * calls, per this package's own "no test ever makes a real network call"
 * discipline.
 */
function createFakeProvider(name: string): {
  provider: VideoProvider;
  submitCalls: VideoGenerationRequest[];
  setNextStatus: (jobExternalId: string, status: VideoGenerationStatus) => void;
} {
  const submitCalls: VideoGenerationRequest[] = [];
  const statusByJobId = new Map<string, VideoGenerationStatus>();
  let counter = 0;

  const provider: VideoProvider = {
    name,
    submit: vi.fn(async (request: VideoGenerationRequest): Promise<VideoGenerationJob> => {
      submitCalls.push(request);
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
    submitCalls,
    setNextStatus: (jobExternalId, status) => {
      statusByJobId.set(jobExternalId, status);
    },
  };
}

const BASE_REQUEST: VideoGenerationRequest = {
  prompt: "A lighthouse beam sweeping across a stormy sea.",
  params: { durationSeconds: 5, aspectRatio: "16:9", seed: 1 },
};

describe("createGenerationStore", () => {
  describe("dedup caching (task 3/6a/6b)", () => {
    it("shares one underlying vendor job when the same request is submitted for two different slots", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      const hashA = await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      const hashB = await store.submitGeneration("slot-b", "veo", { ...BASE_REQUEST });

      expect(hashA).toBe(hashB);
      expect(fake.provider.submit).toHaveBeenCalledTimes(1);

      const entry = store.getCacheEntry(hashA);
      expect(entry?.status).toBe("pending");
    });

    it("shares one underlying vendor job when the identical request is resubmitted to the same slot", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      await store.submitGeneration("slot-a", "veo", { ...BASE_REQUEST });

      expect(fake.provider.submit).toHaveBeenCalledTimes(1);
    });

    it("still dedups when the request's params object was constructed with keys in a different insertion order", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      const requestOrderOne: VideoGenerationRequest = {
        prompt: "Same prompt, different key order",
        params: { durationSeconds: 5, aspectRatio: "16:9", seed: 9 },
      };
      const requestOrderTwo: VideoGenerationRequest = {
        params: { seed: 9, aspectRatio: "16:9", durationSeconds: 5 },
        prompt: "Same prompt, different key order",
      };

      const hashOne = await store.submitGeneration("slot-a", "veo", requestOrderOne);
      const hashTwo = await store.submitGeneration("slot-b", "veo", requestOrderTwo);

      expect(hashOne).toBe(hashTwo);
      expect(fake.provider.submit).toHaveBeenCalledTimes(1);
    });

    it("submits two independent vendor jobs for two genuinely different requests", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      const hashA = await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      const hashB = await store.submitGeneration("slot-b", "veo", {
        ...BASE_REQUEST,
        params: { ...BASE_REQUEST.params, seed: 2 },
      });

      expect(hashA).not.toBe(hashB);
      expect(fake.provider.submit).toHaveBeenCalledTimes(2);
    });
  });

  describe("placeholder resolution while generating (task 2/6c)", () => {
    it("resolves a freshly submitted slot (no prior result) to a spinner placeholder", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      const resolution = store.getSlotStatus("slot-a");

      expect(resolution).toEqual({ status: "pending", placeholder: { kind: "spinner" } });
    });

    it("resolves to ready with the vendor outputUrl once refresh observes success", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);

      fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: "https://vendor.example/clip.mp4" });
      await store.refresh();

      const resolution = store.getSlotStatus("slot-a");
      expect(resolution).toEqual({ status: "ready", outputUrl: "https://vendor.example/clip.mp4" });
    });

    it("resolves to failed with the vendor's error once refresh observes failure", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      fake.setNextStatus("veo-job-1", { status: "failed", error: "vendor rejected the prompt" });
      await store.refresh();

      const resolution = store.getSlotStatus("slot-a");
      expect(resolution).toEqual({ status: "failed", error: "vendor rejected the prompt" });
    });

    it("resolves a regenerating slot to a lastKnownFrame placeholder referencing its prior successful result", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: "https://vendor.example/first.mp4" });
      await store.refresh();
      expect(store.getSlotStatus("slot-a")).toEqual({
        status: "ready",
        outputUrl: "https://vendor.example/first.mp4",
      });

      await store.regenerateSlot("slot-a", { params: { ...BASE_REQUEST.params, seed: 999 } });

      const resolution = store.getSlotStatus("slot-a");
      expect(resolution).toEqual({
        status: "pending",
        placeholder: { kind: "lastKnownFrame", outputUrl: "https://vendor.example/first.mp4" },
      });
    });

    it("does not offer a lastKnownFrame placeholder when the slot's only prior attempt never succeeded", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      // Still pending/running, never reached "ready", when regenerated.
      await store.regenerateSlot("slot-a", { params: { ...BASE_REQUEST.params, seed: 999 } });

      const resolution = store.getSlotStatus("slot-a");
      expect(resolution).toEqual({ status: "pending", placeholder: { kind: "spinner" } });
    });

    it("honors a caller-supplied placeholder preference override", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      const resolution = store.getSlotStatus("slot-a", { prefer: "solid", solidColor: [1, 1, 1, 1] });

      expect(resolution).toEqual({ status: "pending", placeholder: { kind: "solid", color: [1, 1, 1, 1] } });
    });
  });

  describe("regeneration (task 5/6d)", () => {
    it("creates a genuinely new cache entry rather than reusing the slot's previous one", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      const originalHash = await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      const regeneratedHash = await store.regenerateSlot("slot-a");

      expect(regeneratedHash).not.toBe(originalHash);
      expect(fake.provider.submit).toHaveBeenCalledTimes(2);

      const originalEntry = store.getCacheEntry(originalHash);
      const regeneratedEntry = store.getCacheEntry(regeneratedHash);
      expect(originalEntry).toBeDefined();
      expect(regeneratedEntry).toBeDefined();
      expect(originalEntry?.job.externalJobId).not.toBe(regeneratedEntry?.job.externalJobId);
    });

    it("defaults to a fresh random seed, leaving every other request field untouched", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      await store.regenerateSlot("slot-a");

      const secondCall = fake.submitCalls[1];
      expect(secondCall?.prompt).toBe(BASE_REQUEST.prompt);
      expect(secondCall?.params.aspectRatio).toBe(BASE_REQUEST.params.aspectRatio);
      expect(secondCall?.params.durationSeconds).toBe(BASE_REQUEST.params.durationSeconds);
      expect(secondCall?.params.seed).not.toBe(BASE_REQUEST.params.seed);
    });

    it("applies caller-supplied overrides instead of randomizing the seed", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      await store.regenerateSlot("slot-a", { prompt: "A brand new prompt entirely." });

      const secondCall = fake.submitCalls[1];
      expect(secondCall?.prompt).toBe("A brand new prompt entirely.");
      // params untouched by this override, so seed carries over unchanged.
      expect(secondCall?.params.seed).toBe(BASE_REQUEST.params.seed);
    });

    it("regenerating with the exact same overrides as a request already in the cache reuses that cache entry rather than resubmitting", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      const secondRequest: VideoGenerationRequest = {
        ...BASE_REQUEST,
        params: { ...BASE_REQUEST.params, seed: 555 },
      };
      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      const preExistingHash = await store.submitGeneration("slot-b", "veo", secondRequest);
      expect(fake.provider.submit).toHaveBeenCalledTimes(2);

      const regeneratedHash = await store.regenerateSlot("slot-a", { params: { seed: 555 } });

      expect(regeneratedHash).toBe(preExistingHash);
      expect(fake.provider.submit).toHaveBeenCalledTimes(2);
    });

    it("throws UnknownSlotError when regenerating a slot that was never submitted", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await expect(store.regenerateSlot("never-submitted")).rejects.toThrow(UnknownSlotError);
    });
  });

  describe("provider routing and error handling", () => {
    it("throws UnknownProviderError when submitting against an unregistered provider name", async () => {
      const store = createGenerationStore({ providers: {} });

      await expect(store.submitGeneration("slot-a", "does-not-exist", BASE_REQUEST)).rejects.toThrow(
        UnknownProviderError,
      );
    });

    it("throws UnknownSlotError when reading status for a slot that was never submitted", () => {
      const store = createGenerationStore({ providers: {} });

      expect(() => store.getSlotStatus("never-submitted")).toThrow(UnknownSlotError);
    });

    it("routes refresh's poll calls back through the provider named in each cache entry", async () => {
      const veoFake = createFakeProvider("veo");
      const runwayFake = createFakeProvider("runway");
      const store = createGenerationStore({ providers: { veo: veoFake.provider, runway: runwayFake.provider } });

      await store.submitGeneration("slot-veo", "veo", BASE_REQUEST);
      await store.submitGeneration("slot-runway", "runway", {
        ...BASE_REQUEST,
        params: { ...BASE_REQUEST.params, seed: 2 },
      });

      await store.refresh();

      expect(veoFake.provider.poll).toHaveBeenCalledTimes(1);
      expect(runwayFake.provider.poll).toHaveBeenCalledTimes(1);
    });

    it("leaves ready/failed cache entries alone on a subsequent refresh (no further polling of terminal jobs)", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });

      await store.submitGeneration("slot-a", "veo", BASE_REQUEST);
      fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: "https://vendor.example/clip.mp4" });
      await store.refresh();
      expect(fake.provider.poll).toHaveBeenCalledTimes(1);

      await store.refresh();
      expect(fake.provider.poll).toHaveBeenCalledTimes(1);
    });
  });

  describe("store isolation", () => {
    it("does not share cache or slot state between two independently constructed stores", async () => {
      const fakeOne = createFakeProvider("veo");
      const fakeTwo = createFakeProvider("veo");
      const storeOne = createGenerationStore({ providers: { veo: fakeOne.provider } });
      const storeTwo = createGenerationStore({ providers: { veo: fakeTwo.provider } });

      await storeOne.submitGeneration("slot-a", "veo", BASE_REQUEST);

      expect(storeTwo.getSlot("slot-a")).toBeUndefined();
      expect(fakeTwo.provider.submit).not.toHaveBeenCalled();
    });
  });
});
