/**
 * Builds the Cadra `McpServer` instance: an MCP server with the Phase 27
 * contract advertised as a resource, structured (stderr-only) logging, the
 * Phase 29 scene-authoring tools (`create_scene`, `get_scene`,
 * `update_scene`, `validate_scene`, `list_scenes`), the Phase 30 render tools
 * (`render_scene`, `get_render_status`, `get_render_output`), the Phase 30
 * asset tools (`upload_asset`, `list_assets`), the Phase 31 `repair_scene`
 * tool (applies every safe, automatically-derivable fix a scene's current
 * diagnostics carry), the Phase 32 `generate_scene_from_text` tool (turns a
 * natural-language brief into a validated, persisted scene via an LLM), the
 * Phase 35 `get_generation_status` tool (reports a generative-video slot's
 * current status against a `@cadra/providers` `GenerationStore`), the Phase
 * 36 `add_generated_clip` tool (requests a generation and inserts its clip
 * layer onto an existing scene's timeline in one step), the Phase 72
 * `add_text_node` tool (constructs a rich TextNode - stagger/physics/path/
 * morph/fill/outline/glow/shadow/variationAxes included - and inserts it in
 * one step) and `apply_look_preset` tool (applies a named lighting/post/
 * grading/environment bundle onto a composition in one step), and one
 * minimal diagnostic tool.
 *
 * This closes the loop from prompt to finished video: an agent can generate
 * or create a scene, upload assets and reference them by ref in a scene
 * patch, render the scene (`render_scene` submits the job to
 * `@cadra/encode`'s Phase 25 orchestrator and returns immediately with a job
 * id), poll progress (`get_render_status`), and fetch the finished file's
 * reference once done (`get_render_output`). See
 * `./render-store.ts`/`./asset-store.ts` for the workspace/output sandboxing
 * these tools apply, mirroring `scene-store.ts`'s own
 * allow-list-plus-resolved-path-check discipline.
 *
 * One `GenerationStore` instance is constructed here and shared across
 * every tool that touches generative-video state
 * (`registerCadraGenerationTools`, `registerCadraGenerationClipTools`,
 * `registerCadraRenderTools`): `add_generated_clip` submits into it,
 * `get_generation_status` reads its slot statuses, and `render_scene`'s own
 * pre-flight check reads and (via `bindReadyGenerationsForScene`) rewrites
 * it too. Sharing one instance is what makes a slot `add_generated_clip`
 * submits actually observable by the other two - three independently
 * constructed stores would never see each other's state. `options.generation`
 * (if given) supplies this shared instance directly (chiefly for tests
 * injecting a fake-provider-backed store); omitted, a fresh, empty store is
 * constructed (no providers registered), matching every generation-aware
 * tool's own established default rationale.
 */
import { createGenerationStore } from "@cadra/providers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerCadraAssetTools } from "./asset-tools.js";
import type { CadraMcpServerConfig, CadraMcpServerConfigInput } from "./config.js";
import { resolveCadraMcpServerConfig } from "./config.js";
import { registerCadraContractResource } from "./contract-resource.js";
import { registerCadraDescribeSceneTools } from "./describe-scene-tools.js";
import { registerCadraGenerationClipTools } from "./generation-clip-tools.js";
import {
  registerCadraGenerationTools,
  type RegisterCadraGenerationToolsOptions,
} from "./generation-tools.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { registerCadraLookPresetTools } from "./look-preset-tools.js";
import { buildVideoProviderRegistry } from "./provider-registry.js";
import { registerCadraRenderFramesTools } from "./render-frames-tools.js";
import { registerCadraRenderTools } from "./render-tools.js";
import { registerCadraRepairSceneTool } from "./repair-scene-tools.js";
import { registerCadraSceneLintTools } from "./scene-lint-tools.js";
import { registerCadraSceneTools } from "./scene-tools.js";
import { registerCadraTextNodeTools } from "./text-node-tools.js";
import {
  registerCadraTextToSceneTools,
  type RegisterCadraTextToSceneToolsOptions,
} from "./text-to-scene-tools.js";
import { registerCadraWorkspaceHygieneTools } from "./workspace-hygiene-tools.js";

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
  /**
   * Options forwarded to {@link registerCadraTextToSceneTools}, chiefly its
   * `adapterFactory` override. Always supply a fake `adapterFactory` here in
   * tests (see that module's own doc): the real default talks to a paid LLM
   * API, which no test in this codebase may ever actually call.
   */
  textToScene?: RegisterCadraTextToSceneToolsOptions;
  /**
   * Options forwarded to {@link registerCadraGenerationTools}, chiefly its
   * `store` override. This same `GenerationStore` (whether given here or
   * defaulted to a fresh empty one) is also shared with
   * `registerCadraGenerationClipTools` (`add_generated_clip` submits into
   * it) and `registerCadraRenderTools` (`render_scene`'s pre-flight check
   * reads and rewrites it), so all three tools observe the exact same
   * generation-slot state; see this module's own top-level doc. Always
   * supply a pre-populated fake `GenerationStore` here in tests (built with
   * a fake `VideoProvider`, per that module's own doc): the real default
   * starts empty.
   */
  generation?: RegisterCadraGenerationToolsOptions;
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
 * tools, the Phase 30 render and asset tools, and registers the `ping`
 * placeholder tool. Does not attach any transport; call `.connect(transport)`
 * on the returned `server` (or use `./stdio.ts` / `./http.ts`, which do this
 * for you).
 */
export function createCadraMcpServer(options: CreateCadraMcpServerOptions = {}): CadraMcpServer {
  const config = resolveCadraMcpServerConfig(options.config);
  const logger = options.logger ?? createLogger("mcp-server");

  // Shared across every generation-aware tool (see this module's own
  // top-level doc): add_generated_clip submits into it, get_generation_status
  // reads it, and render_scene's pre-flight check reads/rewrites it.
  // Providers are built from config.providerKeys (see ./provider-registry.ts):
  // a vendor with no configured key is simply absent from the registry, so
  // requesting it still fails with the same descriptive UnknownProviderError
  // as before, never a crash from a half-configured adapter.
  const generationStore =
    options.generation?.store ??
    createGenerationStore({ providers: buildVideoProviderRegistry(config.providerKeys) });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        resources: {},
        tools: {},
        logging: {},
      },
      instructions:
        "Cadra exposes a code-first, agent-first 3D video animation scene format. Read the cadra://contract resource for the full JSON Schema, capability manifest, and example scene documents (including a kinetic title sequence, a product shot with IBL and depth of field, and an Arabic-and-Latin animated lower third). Use create_scene, get_scene, update_scene, validate_scene, and list_scenes to author and query scene documents persisted in this server's workspace. Use describe_scene for a compact id/kind/name-only structural outline of one scene instead of get_scene's full per-property JSON - the fast way to see what a scene contains and which node id to target next. Use generate_scene_from_text to generate a scene straight from a natural-language brief via an LLM, persisting the result the same way create_scene does; it self-corrects on an invalid first draft and returns its final diagnostics if every attempt fails. Use add_text_node to construct a rich TextNode (content, font, color, and any of stagger/physics/path/morph/fill/outline/glow/shadow/variationAxes) and insert it onto a scene's timeline in one step, rather than hand-writing the full TextNode JSON; pass typePreset (title/lowerThird/caption/kineticWordReveal) to start from a curated fontSize/stagger/outline/glow/shadow combination, overriding any field passed alongside it. Use apply_look_preset to apply a named cinematic look (a lighting rig plus post-processing/color-grading/environment bundle) onto an existing composition in one call. Use upload_asset to store an image/video/audio/font/glTF asset (by URL or by raw base64 bytes) and get back a cadra-asset:// ref usable in a scene node's assetRef field, and list_assets to see everything already stored. Use render_scene to render a scene's composition to a video file (returns a job id immediately), get_render_status to poll that job's progress, and get_render_output to fetch a reference to the finished file once the job is done. Use render_frames to see specific frames (first/middle/last, or a suspect range) directly as in-band PNG images without waiting on a full render job - the fast way to check whether a scene actually looks right before committing to render_scene. Use probe_render for a fast, low-resolution draft video instead (same jobId/get_render_status/get_render_output flow as render_scene) when you need to check timing/motion across a whole clip, not just individual frames. Use get_generation_status to check a generative-video slot's status (a placeholder while generating, the finished clip's outputUrl once ready, or a failure reason). Use add_generated_clip to request a generative-video job and insert its clip layer onto an existing scene's timeline in one step, without waiting for generation to finish. If a write is rejected, its diagnostics may carry a suggestedPatch; call repair_scene to automatically apply every safe one and re-validate, or fix the remaining diagnostics manually via update_scene. Use scene_lint to catch a static-hold/low-motion composition before rendering it. Use list_outputs to see every render output file currently on disk, delete_output to remove one by name, and prune_outputs to bulk-delete by age/total-size policy (protectFileNames keeps specific files regardless of policy) - render output files can accumulate quickly, and none of this server's render tools delete anything on their own.",
    },
  );

  registerCadraContractResource(server);
  registerCadraSceneTools(server, config, logger);
  registerCadraDescribeSceneTools(server, config, logger);
  registerCadraTextToSceneTools(server, config, logger, options.textToScene);
  registerCadraTextNodeTools(server, config, logger);
  registerCadraLookPresetTools(server, config, logger);
  registerCadraAssetTools(server, config, logger);
  registerCadraRenderTools(server, config, logger, { generationStore });
  registerCadraRenderFramesTools(server, config, logger);
  registerCadraSceneLintTools(server, config, logger);
  registerCadraWorkspaceHygieneTools(server, config, logger);
  registerCadraRepairSceneTool(server, config.workspaceRoot, logger);
  registerCadraGenerationTools(server, config, logger, {
    ...options.generation,
    store: generationStore,
  });
  registerCadraGenerationClipTools(server, config, logger, { store: generationStore });

  server.registerTool(
    PING_TOOL_NAME,
    {
      title: "Ping",
      description:
        "Placeholder diagnostic tool: echoes back a request id and this server's health/config status. Not deliverable scope; a connectivity check only, kept deliberately minimal alongside this server's real scene-authoring, render, and asset tools.",
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
