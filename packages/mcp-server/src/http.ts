/**
 * Streamable HTTP transport entrypoint for the Cadra MCP server.
 *
 * Wires a plain `node:http` server with three routes:
 *   - `GET /health`: a real health check endpoint, answered directly by this
 *     module without going through the MCP protocol at all, so it stays
 *     cheap to poll and meaningful even before any MCP session has been
 *     established.
 *   - `GET /assets?ref=<assetRef>`: streams back a previously-uploaded
 *     asset's raw bytes (see `./asset-store.js`), for a browser-based
 *     consumer with no MCP client of its own - concretely, the studio app's
 *     live viewport, which needs real `ImageNode`/`VideoNode`/`ModelNode`/
 *     `envMapRef`/`lutRef` bytes to render anything but the documented
 *     placeholder. Every response carries a permissive
 *     `Access-Control-Allow-Origin` header (see this module's own CORS note
 *     below).
 *   - `<mcpPath>` (default `/mcp`, any method): delegated to the SDK's
 *     `StreamableHTTPServerTransport`, which implements the full Streamable
 *     HTTP transport (POST for JSON-RPC messages, GET for the SSE stream,
 *     DELETE for session termination).
 *
 * This module intentionally reaches for `node:http` directly rather than a
 * framework: the SDK's own `StreamableHTTPServerTransport.handleRequest`
 * already accepts raw `IncomingMessage`/`ServerResponse`, and this phase's
 * scope is "the server starts, handshakes, and passes a health check" with
 * no routing complexity beyond the routes above.
 *
 * CORS: every response (including 404s and the `OPTIONS` preflight) carries
 * `Access-Control-Allow-Origin: *`. This server has no auth/session model of
 * its own beyond the MCP session id the Streamable HTTP transport already
 * issues, and is meant to run locally alongside a studio dev server on a
 * different port - the same "permissive, local dev tool" posture
 * `host`'s own `127.0.0.1`-only default already establishes, just extended
 * to the browser's own same-origin policy rather than the network layer.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { parseAssetRef, readAssetBytes, readAssetMetadata } from "./asset-store.js";
import type { Logger } from "./logger.js";
import type { CreateCadraMcpServerOptions } from "./server.js";
import { createCadraMcpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

/** Default path the MCP Streamable HTTP endpoint is served under. */
export const DEFAULT_MCP_PATH = "/mcp";

/** Path the health check endpoint is served under; not configurable, matching `/health`'s conventional fixed location. */
export const HEALTH_CHECK_PATH = "/health";

/** Path the asset-bytes endpoint is served under; not configurable, matching `/health`'s own fixed-location convention. */
export const ASSET_BYTES_PATH = "/assets";

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
 * Serves `GET /assets?ref=<assetRef>`: looks `ref` up via `./asset-store.js`
 * and streams its raw bytes back with its own stored content type, or a 404
 * `{error: "not_found"}` for a missing `ref` query parameter, a `ref` outside
 * the `cadra-asset://` scheme, or a `cadra-asset://` ref with no asset
 * actually stored under it - the same three cases `createAssetBytesFetcher`
 * already collapses into a single "unresolved" outcome for a Node-side
 * caller, surfaced here as one uniform HTTP status for a browser-side one.
 *
 * `cache-control: public, max-age=31536000, immutable` is safe because every
 * asset this store holds is content-addressed (`asset-store.ts`'s own top
 * doc): the same `ref` can never later resolve to different bytes, so a
 * browser (or intermediate cache) may keep a response forever.
 */
async function respondWithAssetBytes(
  res: ServerResponse,
  workspaceRoot: string,
  ref: string | null,
  logger: Logger,
): Promise<void> {
  if (ref === null) {
    respondJson(res, 400, {
      error: "missing_ref",
      message: "Expected a `ref` query parameter naming a cadra-asset:// ref.",
    });
    return;
  }

  const hash = parseAssetRef(ref);
  if (hash === undefined) {
    respondJson(res, 404, { error: "not_found" });
    return;
  }

  const metadata = await readAssetMetadata(workspaceRoot, hash);
  if (metadata === undefined) {
    respondJson(res, 404, { error: "not_found" });
    return;
  }
  const bytes = await readAssetBytes(workspaceRoot, hash);
  if (bytes === undefined) {
    logger.error("Asset metadata exists with no corresponding bytes on disk", { ref });
    respondJson(res, 404, { error: "not_found" });
    return;
  }

  res.writeHead(200, {
    "content-type": metadata.contentType ?? "application/octet-stream",
    "content-length": bytes.byteLength,
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(Buffer.from(bytes));
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

  const { server, config, logger } = createCadraMcpServer(serverOptions);
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
    // See this module's own top-level doc for why this is unconditionally
    // permissive: applied before any routing below, so every response this
    // server ever sends (including a 404 for an unknown path) carries it.
    res.setHeader("access-control-allow-origin", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "*",
      });
      res.end();
      return;
    }

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

    if (requestUrl.pathname === ASSET_BYTES_PATH && req.method === "GET") {
      respondWithAssetBytes(res, config.workspaceRoot, requestUrl.searchParams.get("ref"), httpLogger).catch(
        (error: unknown) => {
          httpLogger.error("Unhandled error while serving an asset-bytes request", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            respondJson(res, 500, { error: "internal_error" });
          }
        },
      );
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
