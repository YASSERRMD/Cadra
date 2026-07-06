/**
 * MCP tools that let an agent create, read, update, and validate Cadra scene
 * documents persisted in this server's configured workspace: `create_scene`,
 * `get_scene`, `update_scene` (patch or replace), `validate_scene`, and
 * `list_scenes`.
 *
 * Every write (`create_scene`, `update_scene`) runs its candidate document
 * through `@cadra/schema`'s `parseScene` before persisting anything; on
 * failure, the tool returns `parseScene`'s diagnostics verbatim and leaves
 * whatever was already on disk untouched. Nothing in this module ever writes
 * a document that has not just passed `parseScene`.
 */
import type { Project } from "@cadra/core";
import { createProject } from "@cadra/core";
import { CURRENT_SCHEMA_VERSION, parseScene, type SceneDocument, type SceneParseDiagnostic } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { applyScenePatchOperations, DuplicateNodeIdError, PatchNodeNotFoundError } from "./scene-patch.js";
import { type ScenePatchOperation, scenePatchOperationSchema } from "./scene-patch-schema.js";
import {
  listSceneFiles,
  readSceneFile,
  sanitizeSceneId,
  summarizeSceneDocument,
  writeSceneDocument,
} from "./scene-store.js";

/** Registered tool name for scene creation. */
export const CREATE_SCENE_TOOL_NAME = "create_scene";
/** Registered tool name for reading one full scene document by id. */
export const GET_SCENE_TOOL_NAME = "get_scene";
/** Registered tool name for patching or replacing an existing scene document. */
export const UPDATE_SCENE_TOOL_NAME = "update_scene";
/** Registered tool name for validating a scene document without persisting it. */
export const VALIDATE_SCENE_TOOL_NAME = "validate_scene";
/** Registered tool name for listing every persisted scene as a compact summary. */
export const LIST_SCENES_TOOL_NAME = "list_scenes";

/** A `{ success: false, diagnostics }` tool result payload, shared by every write/validate tool in this module so an agent sees the same shape regardless of which tool rejected its input. */
interface ToolFailurePayload {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

/** A `{ success: true, document }` tool result payload, shared by every tool in this module that hands back a full validated document. */
interface ToolDocumentSuccessPayload {
  success: true;
  document: SceneDocument;
}

/** Builds a single-diagnostic {@link ToolFailurePayload} for an error that is not itself a schema-validation failure (e.g. an unknown scene id, an invalid scene id, a patch targeting a missing node), so every failure mode this module can produce still fits the one `{ success, diagnostics }` shape a caller can branch on uniformly. */
function singleDiagnosticFailure(path: string, message: string, suggestedFix?: string): ToolFailurePayload {
  return {
    success: false,
    diagnostics: [{ path, message, ...(suggestedFix !== undefined ? { suggestedFix } : {}) }],
  };
}

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching the convention the Phase 28 `ping` tool already established. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Validates `sceneId` (rejecting anything that could escape the workspace's
 * `scenes` directory) and returns either the validated id or a ready-to-return
 * tool failure payload. Every tool below that takes a `sceneId` calls this
 * first and returns immediately on failure, so an unsanitary id never reaches
 * `scene-store.ts`'s filesystem calls.
 */
function validateSceneIdOrFailure(
  sceneId: string,
): { ok: true; sceneId: string } | { ok: false; failure: ToolFailurePayload } {
  const validation = sanitizeSceneId(sceneId);
  if (!validation.valid) {
    return { ok: false, failure: singleDiagnosticFailure("sceneId", validation.reason) };
  }
  return { ok: true, sceneId: validation.sceneId };
}

/** A ready-to-return "no scene with this id" failure, shared by every tool that reads an existing scene before writing to it. */
function sceneNotFoundFailure(sceneId: string): ToolFailurePayload {
  return singleDiagnosticFailure(
    "sceneId",
    `No scene with id "${sceneId}" was found in this workspace.`,
    "Call list_scenes to see every scene id currently persisted in this workspace, or " +
      "create_scene to create it first.",
  );
}

/**
 * Reads and parses an existing scene file, returning its validated document
 * or a ready-to-return failure payload covering both "no such scene" and "the
 * persisted file no longer validates" (the latter re-checked on every read
 * rather than trusting disk contents blindly, in case a file was hand-edited
 * or written by an older, incompatible build of this server).
 */
async function loadExistingSceneOrFailure(
  workspaceRoot: string,
  sceneId: string,
  toolLogger: Logger,
): Promise<{ ok: true; document: SceneDocument } | { ok: false; failure: ToolFailurePayload }> {
  const file = await readSceneFile(workspaceRoot, sceneId);
  if (file === undefined) {
    return { ok: false, failure: sceneNotFoundFailure(sceneId) };
  }

  const parsed = parseScene(file.raw);
  if (!parsed.success) {
    toolLogger.warn("Found a persisted scene file that no longer validates", {
      sceneId,
      diagnosticCount: parsed.diagnostics.length,
    });
    return { ok: false, failure: { success: false, diagnostics: parsed.diagnostics } };
  }

  return { ok: true, document: parsed.document };
}

/** Zod shape for the optional initial composition `create_scene` accepts. */
const initialCompositionShape = {
  id: z.string().describe("Unique id for this composition within the new project."),
  name: z.string().describe("Human-readable name for this composition."),
  fps: z.number().describe("Frame rate this composition runs at."),
  durationInFrames: z.number().describe("Total length of this composition, in integer frames."),
  width: z.number().describe("Output width, in pixels."),
  height: z.number().describe("Output height, in pixels."),
};

/** The optional initial composition `create_scene` accepts, once validated against {@link initialCompositionShape}. */
type InitialCompositionInput = z.infer<z.ZodObject<typeof initialCompositionShape>>;

/**
 * Builds a new, empty `Project` for `create_scene`: no compositions if
 * `composition` is omitted, or exactly one composition (with no tracks) if
 * given. Both the project's own id and (if given) the composition's id come
 * directly from the caller (`sceneId`, `composition.id`), so nothing here
 * needs to mint an id of its own; `@cadra/core`'s `createIdGenerator` remains
 * available to a future tool that needs to generate scene-node ids on an
 * agent's behalf (e.g. an `addNode` patch operation building a brand-new
 * node), which this minimal, node-free initial shape does not yet need.
 */
function buildInitialProject(
  sceneId: string,
  name: string,
  composition: InitialCompositionInput | undefined,
): Project {
  return createProject({
    id: sceneId,
    name,
    compositions:
      composition === undefined
        ? []
        : [
            {
              id: composition.id,
              name: composition.name,
              fps: composition.fps,
              durationInFrames: composition.durationInFrames,
              width: composition.width,
              height: composition.height,
              tracks: [],
            },
          ],
  });
}

/**
 * Handles `update_scene`'s "replace" mode: validates `document` as a whole
 * new `SceneDocument`, confirms `sceneId` already exists (replace updates an
 * existing scene, it does not implicitly create one), and persists it.
 */
async function handleReplaceMode(
  workspaceRoot: string,
  toolLogger: Logger,
  sceneId: string,
  document: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (document === undefined) {
    return jsonResult(
      singleDiagnosticFailure(
        "document",
        "mode 'replace' requires a 'document' field with the complete new scene document.",
      ),
    );
  }

  const parsed = parseScene(document);
  if (!parsed.success) {
    return jsonResult({ success: false, diagnostics: parsed.diagnostics } satisfies ToolFailurePayload);
  }

  const existing = await loadExistingSceneOrFailure(workspaceRoot, sceneId, toolLogger);
  if (!existing.ok) {
    return jsonResult(existing.failure);
  }

  await writeSceneDocument(workspaceRoot, sceneId, parsed.document);
  toolLogger.info("update_scene replaced a scene document", { sceneId });
  return jsonResult({ success: true, document: parsed.document } satisfies ToolDocumentSuccessPayload);
}

/**
 * Handles `update_scene`'s "patch" mode: loads the existing document,
 * applies every operation in `operations` in order via
 * `applyScenePatchOperations`, validates the result, and persists it.
 */
async function handlePatchMode(
  workspaceRoot: string,
  toolLogger: Logger,
  sceneId: string,
  operations: ScenePatchOperation[] | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (operations === undefined || operations.length === 0) {
    return jsonResult(
      singleDiagnosticFailure("operations", "mode 'patch' requires a non-empty 'operations' array."),
    );
  }

  const existing = await loadExistingSceneOrFailure(workspaceRoot, sceneId, toolLogger);
  if (!existing.ok) {
    return jsonResult(existing.failure);
  }

  let patchedProject: Project;
  try {
    patchedProject = applyScenePatchOperations(existing.document.project, operations);
  } catch (error) {
    if (error instanceof PatchNodeNotFoundError || error instanceof DuplicateNodeIdError) {
      return jsonResult(singleDiagnosticFailure("operations", error.message));
    }
    throw error;
  }

  const candidate: SceneDocument = {
    schemaVersion: existing.document.schemaVersion,
    project: patchedProject,
  };
  const parsed = parseScene(candidate);
  if (!parsed.success) {
    toolLogger.debug("update_scene patch produced an invalid document", {
      sceneId,
      diagnosticCount: parsed.diagnostics.length,
    });
    return jsonResult({ success: false, diagnostics: parsed.diagnostics } satisfies ToolFailurePayload);
  }

  await writeSceneDocument(workspaceRoot, sceneId, parsed.document);
  toolLogger.info("update_scene patched a scene document", {
    sceneId,
    operationCount: operations.length,
  });
  return jsonResult({ success: true, document: parsed.document } satisfies ToolDocumentSuccessPayload);
}

/**
 * Registers `create_scene`, `get_scene`, `update_scene`, `validate_scene`,
 * and `list_scenes` on `server`, persisting scenes as one JSON file per scene
 * under `config.workspaceRoot`'s `scenes` directory (see `./scene-store.ts`).
 */
export function registerCadraSceneTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
): RegisteredTool[] {
  const toolLogger = logger.child("scene-tools");

  const createSceneTool = server.registerTool(
    CREATE_SCENE_TOOL_NAME,
    {
      title: "Create scene",
      description:
        "Creates a new Cadra scene document and persists it in the configured workspace. " +
        "Validates the assembled document against the Cadra scene schema before writing " +
        "anything; on failure, returns actionable diagnostics and does not create a file. " +
        "Optionally seeds the new project with one empty composition.",
      inputSchema: {
        sceneId: z
          .string()
          .describe(
            "Unique id for the new scene; also used as the new project's own id and as the " +
              "filename this scene is persisted under. Letters, digits, hyphens, and " +
              "underscores only.",
          ),
        name: z.string().describe("Human-readable name for the new project."),
        composition: z
          .object(initialCompositionShape)
          .optional()
          .describe("Optional initial composition to seed the new project with, with no tracks yet."),
      },
    },
    async ({ sceneId, name, composition }) => {
      const idResult = validateSceneIdOrFailure(sceneId);
      if (!idResult.ok) {
        return jsonResult(idResult.failure);
      }

      const project = buildInitialProject(idResult.sceneId, name, composition);
      const candidate = { schemaVersion: CURRENT_SCHEMA_VERSION, project };
      const parsed = parseScene(candidate);

      if (!parsed.success) {
        toolLogger.debug("create_scene rejected an invalid document", {
          sceneId: idResult.sceneId,
          diagnosticCount: parsed.diagnostics.length,
        });
        return jsonResult({ success: false, diagnostics: parsed.diagnostics } satisfies ToolFailurePayload);
      }

      await writeSceneDocument(config.workspaceRoot, idResult.sceneId, parsed.document);
      toolLogger.info("create_scene persisted a new scene", { sceneId: idResult.sceneId });
      return jsonResult({ success: true, document: parsed.document } satisfies ToolDocumentSuccessPayload);
    },
  );

  const getSceneTool = server.registerTool(
    GET_SCENE_TOOL_NAME,
    {
      title: "Get scene",
      description:
        "Reads back the one full scene document persisted under the given scene id. Returns " +
        "an error if no scene with that id exists.",
      inputSchema: {
        sceneId: z.string().describe("Id of the scene to read."),
      },
    },
    async ({ sceneId }) => {
      const idResult = validateSceneIdOrFailure(sceneId);
      if (!idResult.ok) {
        return jsonResult(idResult.failure);
      }

      const existing = await loadExistingSceneOrFailure(config.workspaceRoot, idResult.sceneId, toolLogger);
      if (!existing.ok) {
        return jsonResult(existing.failure);
      }

      return jsonResult({
        success: true,
        document: existing.document,
      } satisfies ToolDocumentSuccessPayload);
    },
  );

  const updateSceneTool = server.registerTool(
    UPDATE_SCENE_TOOL_NAME,
    {
      title: "Update scene",
      description:
        "Updates an existing scene document, either by applying one or more structural patch " +
        "operations (add node, update node fields, remove node, addressed by stable node ids) " +
        "or by replacing the whole document outright. Validates the resulting document against " +
        "the Cadra scene schema before writing; on failure, returns actionable diagnostics and " +
        "leaves the persisted scene unchanged.",
      inputSchema: {
        sceneId: z.string().describe("Id of the scene to update."),
        mode: z
          .enum(["patch", "replace"])
          .describe(
            "'patch' applies 'operations' to the existing document's project. 'replace' " +
              "discards the existing document entirely in favor of 'document'.",
          ),
        operations: z
          .array(scenePatchOperationSchema)
          .optional()
          .describe("Required (and only used) when mode is 'patch': the ordered edits to apply."),
        document: z
          .looseObject({})
          .optional()
          .describe(
            "Required (and only used) when mode is 'replace': the complete new scene document, " +
              "in the same { schemaVersion, project } shape get_scene returns.",
          ),
      },
    },
    async ({ sceneId, mode, operations, document }) => {
      const idResult = validateSceneIdOrFailure(sceneId);
      if (!idResult.ok) {
        return jsonResult(idResult.failure);
      }

      if (mode === "replace") {
        return handleReplaceMode(config.workspaceRoot, toolLogger, idResult.sceneId, document);
      }
      return handlePatchMode(config.workspaceRoot, toolLogger, idResult.sceneId, operations);
    },
  );

  const validateSceneTool = server.registerTool(
    VALIDATE_SCENE_TOOL_NAME,
    {
      title: "Validate scene",
      description:
        "Validates a candidate scene document against the Cadra scene schema without persisting " +
        "it anywhere. Useful for checking a document an agent has assembled in memory before " +
        "calling create_scene or update_scene.",
      inputSchema: {
        document: z
          .looseObject({})
          .describe("The candidate scene document to validate, in the { schemaVersion, project } shape."),
      },
    },
    ({ document }) => {
      const parsed = parseScene(document);
      if (!parsed.success) {
        return jsonResult({ success: false, diagnostics: parsed.diagnostics } satisfies ToolFailurePayload);
      }
      return jsonResult({ success: true, document: parsed.document } satisfies ToolDocumentSuccessPayload);
    },
  );

  const listScenesTool = server.registerTool(
    LIST_SCENES_TOOL_NAME,
    {
      title: "List scenes",
      description:
        "Lists every scene persisted in the configured workspace as a compact summary (id, " +
        "name, composition ids/count, total node count, last-modified time), without returning " +
        "each scene's full document. Call get_scene for one scene's complete document.",
      inputSchema: {},
    },
    async () => {
      const files = await listSceneFiles(config.workspaceRoot);
      const summaries = [];
      for (const file of files) {
        const parsed = parseScene(file.raw);
        if (!parsed.success) {
          toolLogger.warn("list_scenes skipped a persisted file that no longer validates", {
            sceneId: file.sceneId,
            diagnosticCount: parsed.diagnostics.length,
          });
          continue;
        }
        summaries.push(summarizeSceneDocument(file.sceneId, parsed.document, file.lastModified));
      }
      return jsonResult({ scenes: summaries });
    },
  );

  return [createSceneTool, getSceneTool, updateSceneTool, validateSceneTool, listScenesTool];
}
