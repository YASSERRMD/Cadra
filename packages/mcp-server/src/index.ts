/**
 * @cadra/mcp-server
 *
 * The Model Context Protocol server that exposes Cadra to any MCP-capable
 * agent. Phase 28 stands up the server, transport, auth-adjacent
 * configuration, and capability advertisement: it starts, handshakes over
 * both stdio and Streamable HTTP, and exposes Phase 27's
 * `describeCadraContract()` as the `cadra://contract` resource, with a
 * single minimal `ping` diagnostic tool registered alongside it.
 *
 * Scope boundary: this package does not yet register any scene-authoring or
 * render tools (`create_scene`, `render_scene`, and similar land in Phase 29
 * and Phase 30), and `providerKeys` in `./config.ts` is a typed, unwired
 * placeholder ahead of Phase 34's actual generative-video provider
 * integrations.
 *
 * Entry points:
 *   - `createCadraMcpServer` (`./server.ts`): builds an `McpServer` with no
 *     transport attached yet.
 *   - `connectCadraMcpServerStdio` (`./stdio.ts`): builds a server and
 *     connects it over stdio (reads `process.stdin`, writes
 *     `process.stdout`; all logging goes to `stderr`, see `./logger.ts`).
 *   - `startCadraMcpServerHttp` (`./http.ts`): builds a server, connects it
 *     over Streamable HTTP, and serves a real `/health` endpoint alongside
 *     it on a plain `node:http` server.
 */

export const VERSION = "0.0.0";

/**
 * Identifies this package at runtime, useful for diagnostics.
 */
export const PACKAGE_NAME = "@cadra/mcp-server";

export type { CadraMcpServerConfig, CadraMcpServerConfigInput, ProviderKeys } from "./config.js";
export {
  OUTPUT_DIRECTORY_ENV_VAR,
  PROVIDER_KEY_ENV_VAR_PREFIX,
  resolveCadraMcpServerConfig,
  WORKSPACE_ROOT_ENV_VAR,
} from "./config.js";
export { CADRA_CONTRACT_RESOURCE_NAME, CADRA_CONTRACT_RESOURCE_URI } from "./contract-resource.js";
export type {
  CadraMcpHttpServer,
  HealthCheckPayload,
  StartCadraMcpServerHttpOptions,
} from "./http.js";
export { DEFAULT_MCP_PATH, HEALTH_CHECK_PATH, startCadraMcpServerHttp } from "./http.js";
export type { LogEntry, LogFields, Logger, LogLevel, LogSink } from "./logger.js";
export { createLogger } from "./logger.js";
export type { CadraMcpServer, CreateCadraMcpServerOptions } from "./server.js";
export { createCadraMcpServer, PING_TOOL_NAME, SERVER_NAME, SERVER_VERSION } from "./server.js";
export type { CadraMcpStdioServer } from "./stdio.js";
export { connectCadraMcpServerStdio } from "./stdio.js";
