import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import {
  CREATE_SCENE_TOOL_NAME,
  GET_SCENE_TOOL_NAME,
  LIST_SCENES_TOOL_NAME,
  UPDATE_SCENE_TOOL_NAME,
  VALIDATE_SCENE_TOOL_NAME,
} from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

/** Shape every scene tool in this module returns its JSON payload as: one text content block. */
interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content).toBeDefined();
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

interface SuccessDocumentPayload {
  success: true;
  document: SceneDocument;
}

interface FailureDiagnosticsPayload {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

type WritePayload = SuccessDocumentPayload | FailureDiagnosticsPayload;

describe("Cadra MCP scene tools", () => {
  let workspaceRoot: string;
  let client: Client | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-scene-tools-test-"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function connectClient(): Promise<Client> {
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);

    client = newClient;
    return newClient;
  }

  it("lists every registered scene tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        CREATE_SCENE_TOOL_NAME,
        GET_SCENE_TOOL_NAME,
        UPDATE_SCENE_TOOL_NAME,
        VALIDATE_SCENE_TOOL_NAME,
        LIST_SCENES_TOOL_NAME,
      ]),
    );
  });

  describe("create_scene", () => {
    it("creates a new scene with no initial composition and persists it", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-1", name: "My Scene" },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        expect(payload.document.project.id).toBe("scene-1");
        expect(payload.document.project.name).toBe("My Scene");
        expect(payload.document.project.compositions).toEqual([]);
      }
    });

    it("creates a new scene seeded with one initial composition", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-with-comp",
          name: "Scene With Composition",
          composition: {
            id: "comp-1",
            name: "Main",
            fps: 30,
            durationInFrames: 90,
            width: 1920,
            height: 1080,
          },
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        expect(payload.document.project.compositions).toHaveLength(1);
        expect(payload.document.project.compositions[0]?.id).toBe("comp-1");
      }
    });

    it("rejects an unsafe scene id with a path-traversal attempt, and does not create any file", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "../../etc/passwd", name: "Evil" },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics).toHaveLength(1);
        expect(payload.diagnostics[0]?.path).toBe("sceneId");
      }

      // Confirm nothing escaped the workspace: list_scenes should see nothing.
      const listResult = await connectedClient.callTool({ name: LIST_SCENES_TOOL_NAME, arguments: {} });
      const listPayload = parseToolResult<{ scenes: unknown[] }>(listResult as ToolTextResult);
      expect(listPayload.scenes).toEqual([]);
    });

    it("rejects a scene id containing a slash", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "sub/dir", name: "Evil" },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
    });

    it("does not persist a document that fails schema validation", async () => {
      const connectedClient = await connectClient();

      // Duplicate composition ids within the same project fail the schema's
      // cross-field uniqueness check, a validation-level failure distinct
      // from a sanitization-level sceneId rejection.
      const first = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-dup",
          name: "Scene",
          composition: {
            id: "comp-1",
            name: "Main",
            fps: 0,
            durationInFrames: 90,
            width: 1920,
            height: 1080,
          },
        },
      });

      const payload = parseToolResult<WritePayload>(first as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics.length).toBeGreaterThan(0);
      }

      const listResult = await connectedClient.callTool({ name: LIST_SCENES_TOOL_NAME, arguments: {} });
      const listPayload = parseToolResult<{ scenes: unknown[] }>(listResult as ToolTextResult);
      expect(listPayload.scenes).toEqual([]);
    });
  });

  describe("get_scene", () => {
    it("reads back a previously created scene's full document", async () => {
      const connectedClient = await connectClient();

      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-read", name: "Readable Scene" },
      });

      const result = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-read" },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        expect(payload.document.project.name).toBe("Readable Scene");
      }
    });

    it("returns a diagnostic when the scene id does not exist", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "does-not-exist" },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics[0]?.message).toContain("does-not-exist");
      }
    });

    it("rejects an unsafe scene id rather than attempting a filesystem read", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "../outside" },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
    });
  });

  describe("update_scene: patch mode", () => {
    async function createSceneWithRootNode(connectedClient: Client, sceneId: string): Promise<void> {
      const createResult = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          name: "Patchable Scene",
          composition: {
            id: "comp-1",
            name: "Main",
            fps: 30,
            durationInFrames: 90,
            width: 1920,
            height: 1080,
          },
        },
      });
      const created = parseToolResult<WritePayload>(createResult as ToolTextResult);
      expect(created.success).toBe(true);

      // create_scene only seeds an empty composition (no tracks/clips yet); a
      // patch operation needs an existing clip's node tree to anchor onto, so
      // replace the document once with one track/clip/root node before
      // exercising patch mode itself.
      if (created.success) {
        const seeded: SceneDocument = {
          ...created.document,
          project: {
            ...created.document.project,
            compositions: [
              {
                ...created.document.project.compositions[0]!,
                tracks: [
                  {
                    id: "track-1",
                    clips: [
                      {
                        id: "clip-1",
                        startFrame: 0,
                        durationInFrames: 90,
                        node: {
                          id: "root",
                          kind: "group",
                          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                          visible: true,
                          children: [
                            {
                              id: "existing-child",
                              kind: "group",
                              transform: {
                                position: [0, 0, 0],
                                rotation: [0, 0, 0],
                                scale: [1, 1, 1],
                              },
                              visible: true,
                              children: [],
                            },
                          ],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };

        const replaceResult = await connectedClient.callTool({
          name: UPDATE_SCENE_TOOL_NAME,
          arguments: { sceneId, mode: "replace", document: seeded },
        });
        const replaced = parseToolResult<WritePayload>(replaceResult as ToolTextResult);
        expect(replaced.success).toBe(true);
      }
    }

    it("adds a new node as a child of an existing node", async () => {
      const connectedClient = await connectClient();
      await createSceneWithRootNode(connectedClient, "scene-patch-add");

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-patch-add",
          mode: "patch",
          operations: [
            {
              type: "addNode",
              parentId: "root",
              node: {
                id: "new-node",
                kind: "mesh",
                transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
                visible: true,
                geometryRef: "geo-box",
                materialRef: "mat-default",
                children: [],
              },
            },
          ],
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        const rootNode = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
        const childIds = rootNode.children.map((child) => child.id);
        expect(childIds).toContain("new-node");
        // Adding a node must preserve unrelated existing nodes/ids.
        expect(childIds).toContain("existing-child");
      }
    });

    it("updates an existing node's own fields, preserving its id and children", async () => {
      const connectedClient = await connectClient();
      await createSceneWithRootNode(connectedClient, "scene-patch-update");

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-patch-update",
          mode: "patch",
          operations: [
            {
              type: "updateNode",
              nodeId: "existing-child",
              fields: { name: "Renamed" },
            },
          ],
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        const rootNode = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
        const updatedChild = rootNode.children.find((child) => child.id === "existing-child");
        expect(updatedChild?.name).toBe("Renamed");
      }
    });

    it("rejects an updateNode operation whose fields try to change id, kind, or children, at the input-schema level", async () => {
      const connectedClient = await connectClient();
      await createSceneWithRootNode(connectedClient, "scene-patch-forbidden-fields");

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-patch-forbidden-fields",
          mode: "patch",
          operations: [{ type: "updateNode", nodeId: "existing-child", fields: { id: "hijacked-id" } }],
        },
      });

      // A forbidden field name in 'fields' fails the input schema's own
      // refinement before this tool's handler ever runs, so the SDK reports
      // it as an input-validation error (isError: true) rather than this
      // module's own { success, diagnostics } payload shape; the message
      // still names exactly which field and why, so it is just as
      // actionable for an agent to self-correct from.
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("'id', 'kind', 'children'");
    });

    it("removes an existing node from its parent", async () => {
      const connectedClient = await connectClient();
      await createSceneWithRootNode(connectedClient, "scene-patch-remove");

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-patch-remove",
          mode: "patch",
          operations: [{ type: "removeNode", nodeId: "existing-child" }],
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        const rootNode = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
        expect(rootNode.children).toEqual([]);
      }
    });

    it("returns an actionable diagnostic when patching a non-existent node id, and leaves the persisted scene unchanged", async () => {
      const connectedClient = await connectClient();
      await createSceneWithRootNode(connectedClient, "scene-patch-missing");

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-patch-missing",
          mode: "patch",
          operations: [{ type: "updateNode", nodeId: "does-not-exist", fields: { name: "X" } }],
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics).toHaveLength(1);
        expect(payload.diagnostics[0]?.message).toContain("does-not-exist");
      }

      // The persisted scene must be unchanged: existing-child is still there.
      const getResult = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-patch-missing" },
      });
      const getPayload = parseToolResult<WritePayload>(getResult as ToolTextResult);
      expect(getPayload.success).toBe(true);
      if (getPayload.success) {
        const rootNode = getPayload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
        expect(rootNode.children.map((child) => child.id)).toEqual(["existing-child"]);
      }
    });

    it("returns diagnostics when a patch would produce a schema-invalid document, and leaves the persisted scene unchanged", async () => {
      const connectedClient = await connectClient();
      await createSceneWithRootNode(connectedClient, "scene-patch-invalid");

      // Adding a child whose own id collides with an id already in the tree
      // is rejected before it ever reaches parseScene, but an update that
      // introduces a field the node's own kind schema forbids (e.g. a
      // 'mesh'-only field on a 'group' node) is caught by parseScene itself.
      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-patch-invalid",
          mode: "patch",
          operations: [
            {
              type: "updateNode",
              nodeId: "existing-child",
              fields: { geometryRef: "not-a-valid-field-on-a-group-node" },
            },
          ],
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics.length).toBeGreaterThan(0);
      }

      const getResult = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-patch-invalid" },
      });
      const getPayload = parseToolResult<WritePayload>(getResult as ToolTextResult);
      expect(getPayload.success).toBe(true);
      if (getPayload.success) {
        const rootNode = getPayload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
        const child = rootNode.children.find((childNode) => childNode.id === "existing-child");
        expect(child).toBeDefined();
        expect((child as { geometryRef?: string }).geometryRef).toBeUndefined();
      }
    });

    it("returns a diagnostic for mode 'patch' with an empty operations array", async () => {
      const connectedClient = await connectClient();
      await createSceneWithRootNode(connectedClient, "scene-patch-empty");

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-patch-empty", mode: "patch", operations: [] },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
    });

    it("returns a diagnostic patching a scene id that does not exist", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "never-created",
          mode: "patch",
          operations: [{ type: "updateNode", nodeId: "x", fields: { name: "y" } }],
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
    });
  });

  describe("update_scene: replace mode", () => {
    it("replaces the whole document when the new document validates", async () => {
      const connectedClient = await connectClient();
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-replace", name: "Original Name" },
      });

      const replacement: SceneDocument = {
        schemaVersion: 1,
        project: { id: "scene-replace", name: "Replaced Name", compositions: [] },
      };

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-replace", mode: "replace", document: replacement },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        expect(payload.document.project.name).toBe("Replaced Name");
      }
    });

    it("rejects an invalid replacement document with diagnostics, leaving the persisted scene unchanged", async () => {
      const connectedClient = await connectClient();
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-replace-invalid", name: "Original Name" },
      });

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-replace-invalid",
          mode: "replace",
          document: { schemaVersion: 1, project: { id: "x" } },
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics.length).toBeGreaterThan(0);
      }

      const getResult = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-replace-invalid" },
      });
      const getPayload = parseToolResult<WritePayload>(getResult as ToolTextResult);
      expect(getPayload.success).toBe(true);
      if (getPayload.success) {
        expect(getPayload.document.project.name).toBe("Original Name");
      }
    });

    it("returns a diagnostic replacing a scene id that does not exist", async () => {
      const connectedClient = await connectClient();

      const replacement: SceneDocument = {
        schemaVersion: 1,
        project: { id: "never-created", name: "New", compositions: [] },
      };

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "never-created", mode: "replace", document: replacement },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
    });

    it("requires a document field for replace mode", async () => {
      const connectedClient = await connectClient();
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-replace-no-doc", name: "Original" },
      });

      const result = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-replace-no-doc", mode: "replace" },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
    });
  });

  describe("validate_scene", () => {
    it("validates a well-formed document without persisting anything", async () => {
      const connectedClient = await connectClient();

      const document: SceneDocument = {
        schemaVersion: 1,
        project: { id: "in-memory-only", name: "Not Persisted", compositions: [] },
      };

      const result = await connectedClient.callTool({
        name: VALIDATE_SCENE_TOOL_NAME,
        arguments: { document },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);

      const listResult = await connectedClient.callTool({ name: LIST_SCENES_TOOL_NAME, arguments: {} });
      const listPayload = parseToolResult<{ scenes: unknown[] }>(listResult as ToolTextResult);
      expect(listPayload.scenes).toEqual([]);
    });

    it("returns actionable diagnostics for a deliberately-broken document", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: VALIDATE_SCENE_TOOL_NAME,
        arguments: {
          document: {
            schemaVersion: 1,
            project: { id: "broken", name: "Broken", compositions: [{ id: "comp-1" }] },
          },
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics.length).toBeGreaterThan(0);
        for (const diagnostic of payload.diagnostics) {
          expect(typeof diagnostic.path).toBe("string");
          expect(diagnostic.path.length).toBeGreaterThan(0);
          expect(typeof diagnostic.message).toBe("string");
        }
      }
    });

    it("rejects an unsupported schema version with one clear diagnostic", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({
        name: VALIDATE_SCENE_TOOL_NAME,
        arguments: {
          document: {
            schemaVersion: 999,
            project: { id: "x", name: "X", compositions: [] },
          },
        },
      });

      const payload = parseToolResult<WritePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics[0]?.path).toBe("schemaVersion");
      }
    });
  });

  describe("list_scenes", () => {
    it("returns an empty list for a fresh workspace", async () => {
      const connectedClient = await connectClient();

      const result = await connectedClient.callTool({ name: LIST_SCENES_TOOL_NAME, arguments: {} });
      const payload = parseToolResult<{ scenes: unknown[] }>(result as ToolTextResult);
      expect(payload.scenes).toEqual([]);
    });

    it("returns a compact summary (not the full document) for every created scene", async () => {
      const connectedClient = await connectClient();

      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-list-1",
          name: "First Scene",
          composition: {
            id: "comp-1",
            name: "Main",
            fps: 30,
            durationInFrames: 60,
            width: 1280,
            height: 720,
          },
        },
      });
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "scene-list-2", name: "Second Scene" },
      });

      const result = await connectedClient.callTool({ name: LIST_SCENES_TOOL_NAME, arguments: {} });
      const payload = parseToolResult<{
        scenes: Array<{
          id: string;
          name: string;
          compositionIds: string[];
          compositionCount: number;
          nodeCount: number;
          lastModified: string;
        }>;
      }>(result as ToolTextResult);

      expect(payload.scenes).toHaveLength(2);
      const scene1 = payload.scenes.find((scene) => scene.id === "scene-list-1");
      const scene2 = payload.scenes.find((scene) => scene.id === "scene-list-2");

      expect(scene1).toMatchObject({
        id: "scene-list-1",
        name: "First Scene",
        compositionIds: ["comp-1"],
        compositionCount: 1,
        nodeCount: 0,
      });
      expect(typeof scene1?.lastModified).toBe("string");

      expect(scene2).toMatchObject({
        id: "scene-list-2",
        name: "Second Scene",
        compositionIds: [],
        compositionCount: 0,
        nodeCount: 0,
      });

      // Summaries must not carry the full document shape (no 'project' key,
      // no per-composition track/clip data): an agent listing many scenes
      // should not be forced to receive N full documents.
      for (const scene of payload.scenes) {
        expect(scene).not.toHaveProperty("project");
        expect(scene).not.toHaveProperty("tracks");
      }
    });
  });
});
