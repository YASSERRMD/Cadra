import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLACEHOLDER_SOLID_COLOR,
  resolveGenerationStatus,
  resolvePlaceholder,
} from "./placeholder.js";
import type { VideoGenerationStatus } from "./video-provider.js";

describe("resolvePlaceholder", () => {
  it("resolves to lastKnownFrame when a previous output URL is given and no preference is specified", () => {
    const placeholder = resolvePlaceholder("https://vendor.example/prior-clip.mp4");

    expect(placeholder).toEqual({
      kind: "lastKnownFrame",
      outputUrl: "https://vendor.example/prior-clip.mp4",
    });
  });

  it("resolves to spinner when no previous output URL is available", () => {
    const placeholder = resolvePlaceholder(undefined);

    expect(placeholder).toEqual({ kind: "spinner" });
  });

  it("resolves to spinner when a previous output URL exists but spinner is explicitly preferred", () => {
    const placeholder = resolvePlaceholder("https://vendor.example/prior-clip.mp4", { prefer: "spinner" });

    expect(placeholder).toEqual({ kind: "spinner" });
  });

  it("resolves to solid with the default color when solid is preferred and no color is given", () => {
    const placeholder = resolvePlaceholder(undefined, { prefer: "solid" });

    expect(placeholder).toEqual({ kind: "solid", color: DEFAULT_PLACEHOLDER_SOLID_COLOR });
  });

  it("resolves to solid with a caller-supplied color", () => {
    const placeholder = resolvePlaceholder(undefined, {
      prefer: "solid",
      solidColor: [1, 0, 0, 1],
    });

    expect(placeholder).toEqual({ kind: "solid", color: [1, 0, 0, 1] });
  });

  it("ignores a lastKnownFrame preference when there is no previous output URL to reference, falling back to spinner", () => {
    const placeholder = resolvePlaceholder(undefined, { prefer: "lastKnownFrame" });

    expect(placeholder).toEqual({ kind: "spinner" });
  });
});

describe("resolveGenerationStatus", () => {
  it("resolves a succeeded status to ready with its outputUrl", () => {
    const status: VideoGenerationStatus = { status: "succeeded", outputUrl: "https://vendor.example/done.mp4" };

    const resolution = resolveGenerationStatus(status, undefined);

    expect(resolution).toEqual({ status: "ready", outputUrl: "https://vendor.example/done.mp4" });
  });

  it("resolves a failed status to failed with its error message", () => {
    const status: VideoGenerationStatus = { status: "failed", error: "vendor rejected the prompt" };

    const resolution = resolveGenerationStatus(status, undefined);

    expect(resolution).toEqual({ status: "failed", error: "vendor rejected the prompt" });
  });

  it("resolves a pending status to a pending placeholder resolution", () => {
    const status: VideoGenerationStatus = { status: "pending" };

    const resolution = resolveGenerationStatus(status, undefined);

    expect(resolution).toEqual({ status: "pending", placeholder: { kind: "spinner" } });
  });

  it("resolves a running status with a previous output URL to a lastKnownFrame placeholder", () => {
    const status: VideoGenerationStatus = { status: "running" };

    const resolution = resolveGenerationStatus(status, "https://vendor.example/prior.mp4");

    expect(resolution).toEqual({
      status: "running",
      placeholder: { kind: "lastKnownFrame", outputUrl: "https://vendor.example/prior.mp4" },
    });
  });

  it("forwards placeholder preference options through to the underlying placeholder resolution", () => {
    const status: VideoGenerationStatus = { status: "running" };

    const resolution = resolveGenerationStatus(status, "https://vendor.example/prior.mp4", {
      prefer: "solid",
      solidColor: [0, 1, 0, 1],
    });

    expect(resolution).toEqual({
      status: "running",
      placeholder: { kind: "solid", color: [0, 1, 0, 1] },
    });
  });
});
