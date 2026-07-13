#!/usr/bin/env node
/**
 * Streamable HTTP launcher for the Cadra MCP server. Not part of
 * @cadra/mcp-server's own build: imports directly from its built dist, so no
 * extra build step is needed to keep this in sync (mirrors
 * `cadra-mcp-stdio.mjs`'s own rationale exactly).
 *
 * Unlike `cadra-mcp-stdio.mjs` (registered in `.mcp.json`, launched
 * on-demand by an MCP client), nothing currently launches this script
 * automatically: run it directly (`node scripts/cadra-mcp-http.mjs`) when a
 * browser-side consumer needs this workspace's assets over HTTP - concretely,
 * the studio app's live viewport (`apps/studio/src/assets/`), which fetches
 * asset bytes from `GET /assets` (see `packages/mcp-server/src/http.ts`).
 *
 * Binds a fixed default port (not `startCadraMcpServerHttp`'s own
 * OS-assigned-ephemeral default): a browser-side consumer needs a stable,
 * predictable URL to fetch against, not one that changes every run.
 * Override via `CADRA_MCP_HTTP_PORT`/`CADRA_MCP_HTTP_HOST` env vars.
 */
import { startCadraMcpServerHttp } from "../packages/mcp-server/dist/index.js";

const DEFAULT_PORT = 4900;

const port = process.env.CADRA_MCP_HTTP_PORT !== undefined ? Number(process.env.CADRA_MCP_HTTP_PORT) : DEFAULT_PORT;
const host = process.env.CADRA_MCP_HTTP_HOST ?? "127.0.0.1";

try {
  const server = await startCadraMcpServerHttp({ port, host });
  console.log(`[cadra-mcp-http] listening at ${server.url.href}`);
} catch (error) {
  console.error("[cadra-mcp-http] failed to start:", error);
  process.exit(1);
}
