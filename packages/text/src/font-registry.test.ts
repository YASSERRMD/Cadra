import { hashAssetBytes, waitForAssets } from "@cadra/core";
import { describe, expect, it, vi } from "vitest";

import { createFontRegistry } from "./font-registry.js";
import { loadFixtureFont } from "./test-support/load-fixture-font.js";

const ROBOTO_FLEX = loadFixtureFont("RobotoFlex-Variable");

describe("createFontRegistry", () => {
  it("registers already-loaded bytes and resolves them by content hash immediately", async () => {
    const registry = createFontRegistry();
    const registration = registry.registerBytes(ROBOTO_FLEX);
    const parsed = await registration.ready;

    expect(parsed.familyName).toBe("Roboto Flex");
    expect(registry.has(parsed.contentHash)).toBe(true);
    expect(registry.resolve(parsed.contentHash)).toBe(parsed);
  });

  it("resolves nothing for a hash that was never registered", () => {
    const registry = createFontRegistry();

    expect(registry.has(hashAssetBytes(ROBOTO_FLEX))).toBe(false);
    expect(registry.resolve(hashAssetBytes(ROBOTO_FLEX))).toBeUndefined();
  });

  it("registering the same bytes twice parses only once and resolves to the same font", async () => {
    const registry = createFontRegistry();
    const first = await registry.registerBytes(ROBOTO_FLEX).ready;
    const second = await registry.registerBytes(ROBOTO_FLEX).ready;

    expect(second).toBe(first);
  });

  it("gates on a still-loading font via registerPending, matching the Phase 12 Pending contract", async () => {
    const registry = createFontRegistry();
    let resolveBytes!: (bytes: Uint8Array) => void;
    const bytesReady = new Promise<Uint8Array>((resolve) => {
      resolveBytes = resolve;
    });

    const registration = registry.registerPending(bytesReady);
    const onReady = vi.fn();
    void registration.ready.then(onReady);

    await Promise.resolve();
    expect(onReady).not.toHaveBeenCalled();

    resolveBytes(ROBOTO_FLEX);
    const parsed = await registration.ready;

    expect(parsed.familyName).toBe("Roboto Flex");
    expect(registry.resolve(parsed.contentHash)).toBe(parsed);
  });

  it("exposes pendingRegistrations in the exact shape waitForAssets (base Phase 12) expects", async () => {
    const registry = createFontRegistry();
    registry.registerBytes(ROBOTO_FLEX);
    registry.registerPending(Promise.resolve(ROBOTO_FLEX));

    await expect(waitForAssets(registry.pendingRegistrations())).resolves.toBeUndefined();
  });

  it("lets a Node-only caller opt a registration into the fontkit backend", async () => {
    const registry = createFontRegistry("opentype");
    const parsed = await registry.registerBytes(ROBOTO_FLEX, { backend: "fontkit" }).ready;

    expect(parsed.backend).toBe("fontkit");
    expect(parsed.variationAxes.length).toBeGreaterThan(0);
  });
});
