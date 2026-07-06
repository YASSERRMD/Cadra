/**
 * Stdio transport entrypoint for the Cadra MCP server.
 *
 * Health check over stdio: unlike the HTTP transport, stdio has no separate
 * side channel a client could poll (no second port, no extra request type
 * outside the JSON-RPC session itself) without inventing a
 * non-standard extension. Rather than do that, this module treats a
 * successful MCP `initialize` handshake as the stdio health signal: once
 * `connectCadraMcpServerStdio` resolves, the server has attached to stdin/
 * stdout and is ready to serve `resources/list` and `resources/read` for the
 * `ping` tool and the contract resource. A caller that wants an explicit,
 * synchronous-feeling health probe over stdio can call the `ping` tool
 * (see `./server.ts`), which echoes back a status/config payload; this
 * mirrors the HTTP transport's `/health` endpoint without requiring a
 * second transport-like side channel. This choice is documented here
 * rather than silently assumed because it is the one place this phase
 * deviates from "just add a `/health` route": stdio genuinely has nothing
 * equivalent to attach one to.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { CreateCadraMcpServerOptions } from "./server.js";
import { createCadraMcpServer } from "./server.js";

/** A running Cadra MCP server attached to a stdio transport. */
export interface CadraMcpStdioServer {
  /** Closes the underlying transport and server connection. */
  close(): Promise<void>;
}

/**
 * Builds a Cadra MCP server and connects it to a `StdioServerTransport`
 * (reading `process.stdin`, writing `process.stdout`). Resolves once the
 * transport has started; per this module's doc, a resolved promise here is
 * this server's stdio health signal.
 *
 * All logging (see `./logger.ts`) goes to `stderr` unconditionally, so nothing
 * this server or its registered resources/tools log can corrupt the stdout
 * JSON-RPC stream this transport owns.
 */
export async function connectCadraMcpServerStdio(
  options: CreateCadraMcpServerOptions = {},
): Promise<CadraMcpStdioServer> {
  const { server, logger } = createCadraMcpServer(options);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info("Cadra MCP server connected over stdio");

  return {
    close: async () => {
      await server.close();
      logger.info("Cadra MCP server stdio connection closed");
    },
  };
}
