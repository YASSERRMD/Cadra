/**
 * Builds the Cadra `McpServer` instance: an MCP server with the Phase 27
 * contract advertised as a resource, one minimal diagnostic tool, and
 * structured (stderr-only) logging, but with no scene-authoring or render
 * tools registered.
 *
 * Scope boundary (Phase 28): this module is the scaffold only. `create_scene`,
 * `render_scene`, and similar deliverable tools belong to Phase 29 and
 * Phase 30; this file registers exactly one trivial `ping` tool purely as a
 * connectivity/diagnostic placeholder, clearly not deliverable scope.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig, CadraMcpServerConfigInput } from "./config.js";
import { resolveCadraMcpServerConfig } from "./config.js";
import { registerCadraContractResource } from "./contract-resource.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";

/** `Implementation.name` this server advertises during the MCP handshake. */
export const SERVER_NAME = "cadra-mcp-server";

/** `Implementation.version` this server advertises during the MCP handshake; tracks this package's own `VERSION`. */
export const SERVER_VERSION = "0.0.0";

/** Name of the placeholder diagnostic tool registered alongside the contract resource. See this module's doc for why it exists and why it is intentionally minimal. */
export const PING_TOOL_NAME = "ping";

/** Options accepted by {@link createCadraMcpServer}. */
export interface CreateCadraMcpServerOptions {
  /** Configuration input; resolved via {@link resolveCadraMcpServerConfig} (environment-variable fallbacks apply to any omitted field). */
  config?: CadraMcpServerConfigInput;
  /** Logger to use; defaults to a stderr-only {@link createLogger} rooted at `"mcp-server"`. Always writes to stderr regardless of which transport is later attached (see `./logger.ts`'s doc for why this is unconditional). */
  logger?: Logger;
}

/** An `McpServer` plus the resolved configuration and logger it was built with, so a caller (e.g. the stdio/HTTP entrypoints) can log/introspect without re-deriving either. */
export interface CadraMcpServer {
  /** The underlying `McpServer` instance; call `.connect(transport)` to attach a transport. */
  server: McpServer;
  /** Fully-resolved configuration this server was built with. */
  config: CadraMcpServerConfig;
  /** Logger this server (and its registered resources/tools) log through. */
  logger: Logger;
}

/**
 * Constructs a Cadra `McpServer`: advertises the `resources` and `logging`
 * capabilities, registers the `cadra://contract` resource (Phase 27's
 * `describeCadraContract()`), and registers the `ping` placeholder tool.
 * Does not attach any transport; call `.connect(transport)` on the returned
 * `server` (or use `./stdio.ts` / `./http.ts`, which do this for you).
 */
export function createCadraMcpServer(options: CreateCadraMcpServerOptions = {}): CadraMcpServer {
  const config = resolveCadraMcpServerConfig(options.config);
  const logger = options.logger ?? createLogger("mcp-server");

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        resources: {},
        logging: {},
      },
      instructions:
        "Cadra exposes a code-first, agent-first 3D video animation scene format. Read the cadra://contract resource for the full JSON Schema, capability manifest, and example scene documents. This server does not yet expose scene-authoring or render tools; those land in a later phase.",
    },
  );

  registerCadraContractResource(server);

  server.registerTool(
    PING_TOOL_NAME,
    {
      title: "Ping",
      description:
        "Placeholder diagnostic tool: echoes back a request id and this server's health/config status. Not deliverable scope; a connectivity check only, kept deliberately minimal ahead of Phase 29/30's real scene-authoring and render tools.",
      inputSchema: {
        requestId: z
          .string()
          .optional()
          .describe("Arbitrary caller-supplied id, echoed back verbatim."),
      },
    },
    ({ requestId }) => {
      logger.debug("ping tool invoked", { requestId });
      const payload = {
        status: "ok" as const,
        requestId,
        workspaceRoot: config.workspaceRoot,
        outputDirectory: config.outputDirectory,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );

  logger.info("Cadra MCP server constructed", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    workspaceRoot: config.workspaceRoot,
    outputDirectory: config.outputDirectory,
    providerKeyCount: Object.keys(config.providerKeys).length,
  });

  return { server, config, logger };
}
