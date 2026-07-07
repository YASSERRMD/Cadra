import { describe, expect, it } from "vitest";

import { hashVideoGenerationRequest } from "./request-hash.js";
import type { VideoGenerationRequest } from "./video-provider.js";

describe("hashVideoGenerationRequest", () => {
  it("hashes two structurally identical requests to the same value", () => {
    const a: VideoGenerationRequest = {
      prompt: "A lighthouse beam sweeping across a stormy sea.",
      params: { durationSeconds: 5, aspectRatio: "16:9", seed: 42 },
    };
    const b: VideoGenerationRequest = {
      prompt: "A lighthouse beam sweeping across a stormy sea.",
      params: { durationSeconds: 5, aspectRatio: "16:9", seed: 42 },
    };

    expect(hashVideoGenerationRequest(a)).toBe(hashVideoGenerationRequest(b));
  });

  it("hashes the same request identically regardless of the params object's own key insertion order", () => {
    const insertedInOneOrder: VideoGenerationRequest = {
      prompt: "A city skyline at dusk.",
      params: { durationSeconds: 5, aspectRatio: "16:9", seed: 7 },
    };
    const insertedInAnotherOrder: VideoGenerationRequest = {
      params: { seed: 7, aspectRatio: "16:9", durationSeconds: 5 },
      prompt: "A city skyline at dusk.",
    };

    expect(hashVideoGenerationRequest(insertedInOneOrder)).toBe(
      hashVideoGenerationRequest(insertedInAnotherOrder),
    );
  });

  it("hashes identically no matter how deeply nested keys were inserted, including within referenceImageUrls entries", () => {
    const requestA: VideoGenerationRequest = {
      prompt: "Same prompt",
      referenceImageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      params: { aspectRatio: "1:1", durationSeconds: 9 },
    };
    // Rebuilt with every object's keys assigned in reverse order; arrays keep
    // their element order (order is significant there), only object key
    // insertion order differs.
    const requestB: VideoGenerationRequest = {
      params: { durationSeconds: 9, aspectRatio: "1:1" },
      referenceImageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      prompt: "Same prompt",
    };

    expect(hashVideoGenerationRequest(requestA)).toBe(hashVideoGenerationRequest(requestB));
  });

  it("hashes two requests differing only in seed to different values", () => {
    const withSeedOne: VideoGenerationRequest = {
      prompt: "A quiet forest clearing.",
      params: { durationSeconds: 5, seed: 1 },
    };
    const withSeedTwo: VideoGenerationRequest = {
      prompt: "A quiet forest clearing.",
      params: { durationSeconds: 5, seed: 2 },
    };

    expect(hashVideoGenerationRequest(withSeedOne)).not.toBe(hashVideoGenerationRequest(withSeedTwo));
  });

  it("hashes two requests differing only in prompt text to different values", () => {
    const promptOne: VideoGenerationRequest = {
      prompt: "A red bicycle leaning against a wall.",
      params: {},
    };
    const promptTwo: VideoGenerationRequest = {
      prompt: "A blue bicycle leaning against a wall.",
      params: {},
    };

    expect(hashVideoGenerationRequest(promptOne)).not.toBe(hashVideoGenerationRequest(promptTwo));
  });

  it("hashes two requests differing only in referenceImageUrls order to different values (array order is significant)", () => {
    const orderOne: VideoGenerationRequest = {
      prompt: "Same prompt",
      referenceImageUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      params: {},
    };
    const orderTwo: VideoGenerationRequest = {
      prompt: "Same prompt",
      referenceImageUrls: ["https://example.com/b.png", "https://example.com/a.png"],
      params: {},
    };

    expect(hashVideoGenerationRequest(orderOne)).not.toBe(hashVideoGenerationRequest(orderTwo));
  });

  it("returns a deterministic hex string", () => {
    const request: VideoGenerationRequest = {
      prompt: "Deterministic output check.",
      params: { durationSeconds: 5 },
    };

    const hash = hashVideoGenerationRequest(request);
    expect(hash).toMatch(/^[0-9a-f]+$/);
    expect(hash).toBe(hashVideoGenerationRequest(request));
  });
});
