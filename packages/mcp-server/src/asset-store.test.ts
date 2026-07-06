import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashAssetBytes } from "@cadra/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ASSET_REF_SCHEME,
  buildAssetRef,
  listStoredAssets,
  parseAssetRef,
  readAssetBytes,
  readAssetMetadata,
  resolveAssetExtension,
  sanitizeAssetExtension,
  writeAssetFile,
} from "./asset-store.js";

describe("sanitizeAssetExtension", () => {
  it("accepts a plain alphanumeric extension", () => {
    expect(sanitizeAssetExtension("png")).toEqual({ valid: true, extension: "png" });
  });

  it("lowercases the extension", () => {
    expect(sanitizeAssetExtension("PNG")).toEqual({ valid: true, extension: "png" });
  });

  it("rejects an empty extension", () => {
    expect(sanitizeAssetExtension("").valid).toBe(false);
  });

  it("rejects an extension containing '..'", () => {
    expect(sanitizeAssetExtension("..").valid).toBe(false);
  });

  it("rejects an extension containing a path separator", () => {
    expect(sanitizeAssetExtension("png/../../etc").valid).toBe(false);
  });

  it("rejects an extension containing a dot", () => {
    expect(sanitizeAssetExtension("tar.gz").valid).toBe(false);
  });

  it("rejects an overly long extension", () => {
    expect(sanitizeAssetExtension("a".repeat(64)).valid).toBe(false);
  });
});

describe("resolveAssetExtension", () => {
  it("maps a well-known content type to its extension", () => {
    expect(resolveAssetExtension("image/png", undefined)).toBe("png");
    expect(resolveAssetExtension("video/mp4", undefined)).toBe("mp4");
  });

  it("falls back to sniffing the source URL when content type is unknown", () => {
    expect(resolveAssetExtension(undefined, "https://example.com/path/to/file.jpg")).toBe("jpg");
  });

  it("ignores a query string when sniffing the source URL", () => {
    expect(resolveAssetExtension(undefined, "https://example.com/file.webp?cache=1")).toBe("webp");
  });

  it("falls back to the default extension when neither is available", () => {
    expect(resolveAssetExtension(undefined, undefined)).toBe("bin");
  });

  it("falls back to the default extension for a malformed URL", () => {
    expect(resolveAssetExtension(undefined, "not a url")).toBe("bin");
  });

  it("prefers content type over the source URL when both are present", () => {
    expect(resolveAssetExtension("image/png", "https://example.com/file.jpg")).toBe("png");
  });
});

describe("buildAssetRef / parseAssetRef", () => {
  it("round-trips a content hash through the ref scheme", () => {
    const hash = hashAssetBytes(new TextEncoder().encode("hello world"));
    const ref = buildAssetRef(hash);
    expect(ref).toBe(`${ASSET_REF_SCHEME}${hash}`);
    expect(parseAssetRef(ref)).toBe(hash);
  });

  it("returns undefined for a string that does not use the cadra-asset scheme", () => {
    expect(parseAssetRef("https://example.com/asset")).toBeUndefined();
    expect(parseAssetRef("plain-geometry-ref")).toBeUndefined();
  });
});

describe("writeAssetFile / readAssetBytes / readAssetMetadata / listStoredAssets", () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-asset-store-test-"));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("persists bytes and metadata, readable back by hash", async () => {
    const bytes = new TextEncoder().encode("some image bytes");
    const hash = hashAssetBytes(bytes);

    const metadata = await writeAssetFile(workspaceRoot, hash, "png", bytes, {
      contentType: "image/png",
      sourceUrl: "https://example.com/pic.png",
    });

    expect(metadata.hash).toBe(hash);
    expect(metadata.extension).toBe("png");
    expect(metadata.sizeBytes).toBe(bytes.byteLength);
    expect(metadata.contentType).toBe("image/png");
    expect(metadata.sourceUrl).toBe("https://example.com/pic.png");
    expect(typeof metadata.uploadedAt).toBe("string");

    const readBack = await readAssetBytes(workspaceRoot, hash);
    expect(readBack).toBeDefined();
    expect(Uint8Array.from(readBack!)).toEqual(bytes);

    const readMeta = await readAssetMetadata(workspaceRoot, hash);
    expect(readMeta).toEqual(metadata);
  });

  it("returns undefined for an unknown hash", async () => {
    expect(await readAssetBytes(workspaceRoot, "0".repeat(16))).toBeUndefined();
    expect(await readAssetMetadata(workspaceRoot, "0".repeat(16))).toBeUndefined();
  });

  it("returns an empty list when no assets directory exists yet", async () => {
    expect(await listStoredAssets(workspaceRoot)).toEqual([]);
  });

  it("deduplicates re-uploads of identical bytes: no second copy, original metadata preserved", async () => {
    const bytes = new TextEncoder().encode("duplicate me");
    const hash = hashAssetBytes(bytes);

    const first = await writeAssetFile(workspaceRoot, hash, "bin", bytes, {
      sourceUrl: "https://example.com/first-upload",
    });
    const second = await writeAssetFile(workspaceRoot, hash, "bin", bytes, {
      sourceUrl: "https://example.com/second-upload-should-be-ignored",
    });

    expect(second).toEqual(first);
    expect(second.sourceUrl).toBe("https://example.com/first-upload");

    const listed = await listStoredAssets(workspaceRoot);
    expect(listed).toHaveLength(1);
  });

  it("lists every stored asset with its resolved asset ref", async () => {
    const bytesA = new TextEncoder().encode("asset A");
    const bytesB = new TextEncoder().encode("asset B");
    const hashA = hashAssetBytes(bytesA);
    const hashB = hashAssetBytes(bytesB);

    await writeAssetFile(workspaceRoot, hashA, "png", bytesA, { contentType: "image/png" });
    await writeAssetFile(workspaceRoot, hashB, "mp4", bytesB, { contentType: "video/mp4" });

    const listed = await listStoredAssets(workspaceRoot);
    const refs = listed.map((asset) => asset.assetRef).sort();
    expect(refs).toEqual([buildAssetRef(hashA), buildAssetRef(hashB)].sort());

    for (const asset of listed) {
      expect(asset.assetRef).toBe(buildAssetRef(asset.hash));
    }
  });

  it("skips a stray metadata file that does not parse as JSON", async () => {
    const bytes = new TextEncoder().encode("valid asset");
    const hash = hashAssetBytes(bytes);
    await writeAssetFile(workspaceRoot, hash, "bin", bytes, {});

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(workspaceRoot, "assets", "not-json.meta.json"), "{ not valid json", "utf8");

    const listed = await listStoredAssets(workspaceRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.hash).toBe(hash);
  });
});
