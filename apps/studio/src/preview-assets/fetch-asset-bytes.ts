/**
 * Path the MCP server's asset-bytes endpoint is served under. Duplicated
 * (not imported) from `packages/mcp-server/src/http.ts`'s own
 * `ASSET_BYTES_PATH`: `@cadra/mcp-server` is a Node-targeted package (real
 * `node:fs`/`node:http` throughout), unsafe to pull into a browser bundle
 * for the sake of one string constant. Keep this in sync with that module's
 * own `ASSET_BYTES_PATH` if it ever changes.
 */
const ASSET_BYTES_PATH = "/assets";

/** Default base URL `scripts/cadra-mcp-http.mjs` binds to; see that script's own doc. */
export const DEFAULT_MCP_HTTP_URL = "http://127.0.0.1:4900";

/**
 * Builds a `FetchBytes` (`@cadra/renderer`'s own asset-loader dependency
 * shape: `(url: string) => Promise<Uint8Array>`) that fetches an asset's
 * bytes from a running Cadra MCP server's `GET /assets?ref=<assetRef>`
 * endpoint (`packages/mcp-server/src/http.ts`).
 *
 * Named `url` (matching `FetchBytes`'s own parameter name) but is actually
 * always called with a `cadra-asset://` ref, never a real URL: every loader
 * in `@cadra/renderer`'s `assets/` directory treats its own `url` parameter
 * as an opaque identifier to hand back to `fetchBytes`, never parses it
 * itself, so passing an asset ref through unchanged is exactly the intended
 * use of that seam.
 *
 * Throws (never returns `undefined`) on a network error or a non-2xx
 * response, matching `FetchBytes`'s own contract (`loadImage`/`loadVideo`/
 * etc. all `await deps.fetchBytes(url)` with no try/catch of their own) -
 * `build-preview-registries.ts` is what catches per-asset failures and logs
 * them, the same "resolve-only, unresolved is expected" contract this
 * codebase's Node-side registry builders already establish.
 */
export function createFetchAssetBytesOverHttp(baseUrl: string = DEFAULT_MCP_HTTP_URL): (assetRef: string) => Promise<Uint8Array> {
  return async (assetRef: string): Promise<Uint8Array> => {
    const url = new URL(ASSET_BYTES_PATH, baseUrl);
    url.searchParams.set("ref", assetRef);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch asset "${assetRef}" from ${url.href}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
}
