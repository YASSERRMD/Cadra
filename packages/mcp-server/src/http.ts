/**
 * Streamable HTTP transport entrypoint for the Cadra MCP server.
 *
 * Wires a plain `node:http` server with two routes:
 *   - `GET /health`: a real health check endpoint, answered directly by this
 *     module without going through the MCP protocol at all, so it stays
 *     cheap to poll and meaningful even before any MCP session has been
 *     established.
 *   - `<mcpPath>` (default `/mcp`, any method): delegated to the SDK's
 *     `StreamableHTTPServerTransport`, which implements the full Streamable
 *     HTTP transport (POST for JSON-RPC messages, GET for the SSE stream,
 *     DELETE for session termination).
 *
 * This module intentionally reaches for `node:http` directly rather than a
 * framework: the SDK's own `StreamableHTTPServerTransport.handleRequest`
 * already accepts raw `IncomingMessage`/`ServerResponse`, and this phase's
 * scope is "the server starts, handshakes, and passes a health check" with
 * no routing complexity beyond the two routes above.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { CreateCadraMcpServerOptions } from "./server.js";
import { createCadraMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

/** Default path the MCP Streamable HTTP endpoint is served under. */
export const DEFAULT_MCP_PATH = "/mcp";

/** Path the health check endpoint is served under; not configurable, matching `/health`'s conventional fixed location. */
export const HEALTH_CHECK_PATH = "/health";

/** Shape of the JSON body `/health` responds with. */
export interface HealthCheckPayload {
  /** Always `"ok"`; a real check would only ever respond at all when healthy, so this field exists for forward compatibility with a future non-200 case, not because it varies today. */
  status: "ok";
  /** `Implementation.name` this server advertises during the MCP handshake. */
  server: string;
  /** `Implementation.version` this server advertises during the MCP handshake. */
  version: string;
}

/** Options accepted by {@link startCadraMcpServerHttp}. */
export interface StartCadraMcpServerHttpOptions extends CreateCadraMcpServerOptions {
  /** Port to listen on. Defaults to `0` (OS-assigned ephemeral port), which is picked up from `server.address()` after `listen` resolves. */
  port?: number;
  /** Host to bind to. Defaults to `"127.0.0.1"`. */
  host?: string;
  /** Path the MCP Streamable HTTP endpoint is served under. Defaults to {@link DEFAULT_MCP_PATH}. */
  mcpPath?: string;
}

/** A running Cadra MCP server attached to a Streamable HTTP transport. */
export interface CadraMcpHttpServer {
  /** The underlying `node:http` server. */
  httpServer: Server;
  /** Resolved base URL (`http://<host>:<port>`) once listening; use this to build the MCP endpoint and health check URLs. */
  url: URL;
  /** Closes the HTTP server and the underlying MCP transport/session. */
  close(): Promise<void>;
}

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Builds a Cadra MCP server, attaches it to a `StreamableHTTPServerTransport`,
 * and serves both that transport and a real `/health` endpoint over a plain
 * `node:http` server. Resolves once the HTTP server is listening.
 *
 * Session handling is stateful (a `sessionIdGenerator` is supplied), matching
 * the SDK's documented "stateful mode": the transport issues a session id on
 * initialize and every subsequent request in that session must present it.
 */
export async function startCadraMcpServerHttp(
  options: StartCadraMcpServerHttpOptions = {},
): Promise<CadraMcpHttpServer> {
  const { port = 0, host = "127.0.0.1", mcpPath = DEFAULT_MCP_PATH, ...serverOptions } = options;

  const { server, logger } = createCadraMcpServer(serverOptions);
  const httpLogger = logger.child("http-transport");

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      httpLogger.info("MCP session initialized", { sessionId });
    },
    onsessionclosed: (sessionId) => {
      httpLogger.info("MCP session closed", { sessionId });
    },
  });

  await server.connect(transport);

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url ?? "/", "http://internal.invalid");

    if (requestUrl.pathname === HEALTH_CHECK_PATH) {
      const payload: HealthCheckPayload = {
        status: "ok",
        server: SERVER_NAME,
        version: SERVER_VERSION,
      };
      respondJson(res, 200, payload);
      return;
    }

    if (requestUrl.pathname === mcpPath) {
      transport.handleRequest(req, res).catch((error: unknown) => {
        httpLogger.error("Unhandled error while processing MCP HTTP request", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          respondJson(res, 500, { error: "internal_error" });
        }
      });
      return;
    }

    respondJson(res, 404, { error: "not_found" });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the Cadra MCP HTTP server to bind to a network address.");
  }
  const url = new URL(`http://${host}:${address.port}`);

  httpLogger.info("Cadra MCP server listening over Streamable HTTP", {
    url: url.href,
    mcpPath,
    healthCheckPath: HEALTH_CHECK_PATH,
  });

  return {
    httpServer,
    url,
    close: async () => {
      // `server.close()` closes the underlying transport too (an `McpServer`
      // delegates through `Server`/`Protocol.close()`, which calls
      // `this._transport?.close()`), so closing `transport` separately here
      // would be redundant.
      await server.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      httpLogger.info("Cadra MCP HTTP server closed");
    },
  };
}
