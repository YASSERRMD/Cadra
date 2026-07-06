/**
 * Builds the Cadra `McpServer` instance: an MCP server with the Phase 27
 * contract advertised as a resource, structured (stderr-only) logging, the
 * Phase 29 scene-authoring tools (`create_scene`, `get_scene`,
 * `update_scene`, `validate_scene`, `list_scenes`), and one minimal
 * diagnostic tool.
 *
 * Scope boundary (Phase 29): `render_scene` and similar render/asset tools
 * belong to Phase 30, along with the deeper workspace/output sandboxing
 * those tools need; this phase's scene tools sandbox only their own
 * scene-id-to-filesystem-path mapping (see `./scene-store.ts`).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig, CadraMcpServerConfigInput } from "./config.js";
import { resolveCadraMcpServerConfig } from "./config.js";
import { registerCadraContractResource } from "./contract-resource.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { registerCadraSceneTools } from "./scene-tools.js";

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
 * Constructs a Cadra `McpServer`: advertises the `resources`, `tools`, and
 * `logging` capabilities, registers the `cadra://contract` resource (Phase
 * 27's `describeCadraContract()`), registers the Phase 29 scene-authoring
 * tools, and registers the `ping` placeholder tool. Does not attach any
 * transport; call `.connect(transport)` on the returned `server` (or use
 * `./stdio.ts` / `./http.ts`, which do this for you).
 */
export function createCadraMcpServer(options: CreateCadraMcpServerOptions = {}): CadraMcpServer {
  const config = resolveCadraMcpServerConfig(options.config);
  const logger = options.logger ?? createLogger("mcp-server");

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        resources: {},
        tools: {},
        logging: {},
      },
      instructions:
        "Cadra exposes a code-first, agent-first 3D video animation scene format. Read the cadra://contract resource for the full JSON Schema, capability manifest, and example scene documents. Use create_scene, get_scene, update_scene, validate_scene, and list_scenes to author and query scene documents persisted in this server's workspace. This server does not yet expose render/asset tools; those land in a later phase.",
    },
  );

  registerCadraContractResource(server);
  registerCadraSceneTools(server, config, logger);

  server.registerTool(
    PING_TOOL_NAME,
    {
      title: "Ping",
      description:
        "Placeholder diagnostic tool: echoes back a request id and this server's health/config status. Not deliverable scope; a connectivity check only, kept deliberately minimal alongside this server's real scene-authoring tools and ahead of Phase 30's render/asset tools.",
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
