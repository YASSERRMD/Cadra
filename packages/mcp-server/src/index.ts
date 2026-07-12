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
 * `workspaceRoot`'s `scenes` directory. Phase 30 closes the loop from prompt
 * to finished video: `render_scene` submits a render job for one composition
 * within an existing scene to `@cadra/encode`'s Phase 25 render-job
 * orchestrator and returns a job id immediately, `get_render_status` polls
 * that job's live per-range progress, and `get_render_output` returns a
 * reference to the finished file once done; `upload_asset` stores an asset
 * (by URL or by raw base64 bytes) content-addressed under the workspace and
 * returns a `cadra-asset://<hash>` ref usable directly in a scene node's
 * `assetRef` field, and `list_assets` lists everything stored. Phase 32 adds
 * `generate_scene_from_text`: turns a natural-language brief (plus optional
 * duration/fps/size constraints) into a validated scene document via an LLM
 * (`@cadra/agent-sdk`'s `TextToScene` adapter, self-correcting on an invalid
 * first draft by re-prompting with the exact validation diagnostics found),
 * persisting the result under the workspace exactly like `create_scene`
 * does. This is `providerKeys` in `./config.ts`'s first real consumer:
 * `providerKeys.anthropic`, if set, is used as the API key for this tool's
 * default `@anthropic-ai/sdk`-backed adapter. A single minimal `ping`
 * diagnostic tool remains registered alongside them all.
 *
 * Phase 34 adds five generative-video provider adapters in
 * `@cadra/providers` (`VideoProvider`, submit/poll: Veo, Runway, Kling,
 * Luma, Pika). `./provider-registry.ts`'s `buildVideoProviderRegistry`
 * constructs whichever of those five `createCadraMcpServer` actually has a
 * configured key for from `providerKeys` (`CADRA_PROVIDER_KEY_VEO`,
 * `_RUNWAY`, `_LUMA`, `_PIKA` each a single key; `_KLING_ACCESS` +
 * `_KLING_SECRET` together, matching Kling's own AK/SK auth scheme) and
 * passes the result into the shared `GenerationStore` `server.ts`
 * constructs - an unconfigured vendor is simply absent from that registry,
 * so requesting it still fails with a descriptive `UnknownProviderError`
 * rather than a crash from a half-configured adapter. Phase 35 adds
 * `get_generation_status`: reports a generative-video slot's current status
 * against that `GenerationStore` (a content-hash-keyed dedup cache plus
 * caller-named generation slots) - a placeholder descriptor while
 * generating, the finished clip's `outputUrl` once ready, or a failure
 * reason.
 *
 * Phase 36 closes the generative-video loop: `add_generated_clip`
 * (`./generation-clip-tools.ts`) submits a generation and inserts a new
 * `VideoNode`-bearing `Clip` (with the placeholder
 * `cadra-generation://<slotId>` ref, and an optional `transitionIn`) onto an
 * existing scene's timeline in one step, returning immediately without
 * blocking on generation completion. `./generation-asset-binding.ts` binds a
 * ready generation's output onto its waiting node automatically: the very
 * next time `get_generation_status` or `render_scene` checks that slot's
 * status, its `outputUrl` is ingested into the durable asset store (reusing
 * `./asset-store.ts`'s `ingestAssetFromUrl`, the same function `upload_asset`
 * itself calls) and the node's `assetRef` is rewritten from the generation
 * ref to a real `cadra-asset://<hash>` ref. `render_scene` also refuses to
 * submit a render whose composition still has a not-yet-ready
 * generation-backed node, rather than rendering against a broken placeholder
 * ref; `./generation-pending-assets.ts`'s `createGenerationPendingAssets`
 * additionally wires this same readiness gate into `@cadra/headless`'s
 * `renderComposition` `getPendingAssets` option directly, for any caller
 * driving that lower-level render loop itself. `VideoNode` also gained
 * optional `blendMode`/`maskRef` fields (Phase 36), so a generated layer can
 * express a blend or mask against a synthetic one; the scene DSL validates
 * and round-trips them even though `packages/renderer`'s `"video"` node
 * handling remains a placeholder plane (unchanged since Phase 33).
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

export type { AssetMetadata, StoredAssetSummary } from "./asset-store.js";
export {
  ASSET_REF_SCHEME,
  buildAssetRef,
  listStoredAssets,
  parseAssetRef,
  readAssetBytes,
  readAssetMetadata,
  resolveAssetExtension,
  sanitizeAssetExtension,
  writeAssetFile,
} from "./asset-store.js";
export {
  LIST_ASSETS_TOOL_NAME,
  registerCadraAssetTools,
  UPLOAD_ASSET_TOOL_NAME,
} from "./asset-tools.js";
export type { CadraMcpServerConfig, CadraMcpServerConfigInput, ProviderKeys } from "./config.js";
export {
  OUTPUT_DIRECTORY_ENV_VAR,
  PROVIDER_KEY_ENV_VAR_PREFIX,
  resolveCadraMcpServerConfig,
  WORKSPACE_ROOT_ENV_VAR,
} from "./config.js";
export { CADRA_CONTRACT_RESOURCE_NAME, CADRA_CONTRACT_RESOURCE_URI } from "./contract-resource.js";
export type {
  GenerationBindingOutcome,
  PendingGenerationNode,
} from "./generation-asset-binding.js";
export {
  bindReadyGenerations,
  bindReadyGenerationsForScene,
  buildGenerationRef,
  findPendingGenerationNodes,
  GENERATION_REF_SCHEME,
  parseGenerationRef,
} from "./generation-asset-binding.js";
export type { RegisterCadraGenerationClipToolsOptions } from "./generation-clip-tools.js";
export {
  ADD_GENERATED_CLIP_TOOL_NAME,
  registerCadraGenerationClipTools,
} from "./generation-clip-tools.js";
export { createGenerationPendingAssets } from "./generation-pending-assets.js";
export type { RegisterCadraGenerationToolsOptions } from "./generation-tools.js";
export {
  GET_GENERATION_STATUS_TOOL_NAME,
  registerCadraGenerationTools,
} from "./generation-tools.js";
export type {
  CadraMcpHttpServer,
  HealthCheckPayload,
  StartCadraMcpServerHttpOptions,
} from "./http.js";
export { DEFAULT_MCP_PATH, HEALTH_CHECK_PATH, startCadraMcpServerHttp } from "./http.js";
export type { LogEntry, LogFields, Logger, LogLevel, LogSink } from "./logger.js";
export { createLogger } from "./logger.js";
export type {
  RenderJobRecord,
  SerializedJobStatus,
  SerializedRangeError,
  SerializedRangeState,
} from "./render-store.js";
export {
  getRenderJobRecord,
  mintRenderJobId,
  registerRenderJob,
  resolveRenderOutputPath,
  serializeJobStatus,
  setRenderJobOutcome,
  trackRenderJobOutcome,
} from "./render-store.js";
export {
  GET_RENDER_OUTPUT_TOOL_NAME,
  GET_RENDER_STATUS_TOOL_NAME,
  registerCadraRenderTools,
  RENDER_SCENE_TOOL_NAME,
} from "./render-tools.js";
export { registerCadraRepairSceneTool, REPAIR_SCENE_TOOL_NAME } from "./repair-scene-tools.js";
export {
  applyScenePatchOperation,
  applyScenePatchOperations,
  DuplicateNodeIdError,
  PatchNodeNotFoundError,
  projectContainsNodeId,
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
export type {
  RegisterCadraTextToSceneToolsOptions,
  TextToSceneAdapterFactory,
  TextToSceneAdapterFactoryOptions,
} from "./text-to-scene-tools.js";
export {
  createDefaultTextToSceneAdapter,
  GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
  registerCadraTextToSceneTools,
} from "./text-to-scene-tools.js";
