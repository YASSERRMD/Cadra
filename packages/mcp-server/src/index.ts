/**
 * @cadra/mcp-server
 *
 * The Model Context Protocol server that exposes Cadra to any MCP-capable
 * agent. Phase 28 stood up the server, transport, auth-adjacent
 * configuration, and capability advertisement: it starts, handshakes over
 * both stdio and Streamable HTTP, and exposes Phase 27's
 * `describeCadraContract()` as the `cadra://contract` resource. Phase 29
 * adds the scene-authoring tools an agent actually calls to create, read,
 * update, and validate scene documents: `create_scene`, `get_scene`,
 * `update_scene` (patch or replace), `validate_scene`, and `list_scenes`,
 * each persisting scenes as one JSON file per scene under the configured
 * `workspaceRoot`'s `scenes` directory. A single minimal `ping` diagnostic
 * tool remains registered alongside them.
 *
 * Scope boundary: this package does not yet register any render/asset tools
 * (`render_scene` and similar land in Phase 30, along with the deeper
 * workspace/output sandboxing those tools need), and `providerKeys` in
 * `./config.ts` is a typed, unwired placeholder ahead of Phase 34's actual
 * generative-video provider integrations.
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
export {
  applyScenePatchOperation,
  applyScenePatchOperations,
  DuplicateNodeIdError,
  PatchNodeNotFoundError,
} from "./scene-patch.js";
export {
  addNodeOperationSchema,
  removeNodeOperationSchema,
  type ScenePatchOperation,
  scenePatchOperationSchema,
  updateNodeOperationSchema,
} from "./scene-patch-schema.js";
export type { SceneFileContents, SceneIdValidationResult, SceneSummary } from "./scene-store.js";
export {
  deleteSceneFile,
  listSceneFiles,
  readSceneFile,
  sanitizeSceneId,
  summarizeSceneDocument,
  writeSceneDocument,
} from "./scene-store.js";
export {
  CREATE_SCENE_TOOL_NAME,
  GET_SCENE_TOOL_NAME,
  LIST_SCENES_TOOL_NAME,
  registerCadraSceneTools,
  UPDATE_SCENE_TOOL_NAME,
  VALIDATE_SCENE_TOOL_NAME,
} from "./scene-tools.js";
export type { CadraMcpServer, CreateCadraMcpServerOptions } from "./server.js";
export { createCadraMcpServer, PING_TOOL_NAME, SERVER_NAME, SERVER_VERSION } from "./server.js";
export type { CadraMcpStdioServer } from "./stdio.js";
export { connectCadraMcpServerStdio } from "./stdio.js";
