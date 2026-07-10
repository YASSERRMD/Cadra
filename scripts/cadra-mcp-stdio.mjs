#!/usr/bin/env node
/**
 * Stdio launcher for the Cadra MCP server, registered as this project's
 * "cadra" server in .mcp.json. Not part of @cadra/mcp-server's own build:
 * imports directly from its built dist so no extra build step is needed to
 * keep this in sync. Must never write to stdout itself, since that stream
 * is owned by the MCP JSON-RPC transport once connected (see
 * packages/mcp-server/src/stdio.ts).
 */
import { connectCadraMcpServerStdio } from "../packages/mcp-server/dist/index.js";

try {
  await connectCadraMcpServerStdio();
} catch (error) {
  console.error("[cadra-mcp-stdio] failed to start:", error);
  process.exit(1);
}
