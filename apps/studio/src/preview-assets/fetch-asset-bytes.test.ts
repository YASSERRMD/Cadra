import { afterEach, describe, expect, it, vi } from "vitest";

import { createFetchAssetBytesOverHttp } from "./fetch-asset-bytes.js";

describe("createFetchAssetBytesOverHttp", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches GET {baseUrl}/assets?ref=<encoded assetRef> and returns the response bytes", async () => {
    const sourceBytes = new Uint8Array([9, 8, 7, 6]);
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(input);
      expect(url.origin).toBe("http://127.0.0.1:5555");
      expect(url.pathname).toBe("/assets");
      expect(url.searchParams.get("ref")).toBe("cadra-asset://abc def");
      return new Response(sourceBytes, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchAssetBytes = createFetchAssetBytesOverHttp("http://127.0.0.1:5555");
    const result = await fetchAssetBytes("cadra-asset://abc def");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Array.from(result)).toEqual(Array.from(sourceBytes));
  });

  it("throws a descriptive error for a non-2xx response, rather than returning undefined", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const fetchAssetBytes = createFetchAssetBytesOverHttp("http://127.0.0.1:5555");

    await expect(fetchAssetBytes("cadra-asset://missing")).rejects.toThrow(/404/);
  });

  it("propagates a real network error (server not running) as a rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const fetchAssetBytes = createFetchAssetBytesOverHttp("http://127.0.0.1:5555");

    await expect(fetchAssetBytes("cadra-asset://x")).rejects.toThrow("Failed to fetch");
  });

  it("defaults to DEFAULT_MCP_HTTP_URL when no baseUrl is given", async () => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      const url = new URL(input);
      expect(url.origin).toBe("http://127.0.0.1:4900");
      return new Response(new Uint8Array([1]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const fetchAssetBytes = createFetchAssetBytesOverHttp();
    await fetchAssetBytes("cadra-asset://x");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
