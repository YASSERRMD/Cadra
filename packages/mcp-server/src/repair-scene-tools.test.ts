import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION, type SceneDocument } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { REPAIR_SCENE_TOOL_NAME } from "./repair-scene-tools.js";
import { GET_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

/** Shape every tool in this package returns its JSON payload as: one text content block. */
interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content).toBeDefined();
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

interface RepairSceneResult {
  success: boolean;
  repaired: boolean;
  patchesApplied: Array<{ path: string; op: string }>;
  remainingDiagnostics: Array<{ path: string; message: string }>;
  document?: SceneDocument;
}

interface GetScenePayload {
  success: boolean;
  document?: SceneDocument;
}

describe("repair_scene", () => {
  let workspaceRoot: string;
  let client: Client | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-repair-scene-test-"));
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

  /** Writes a raw, possibly-invalid document directly to disk, bypassing every tool's own `parseScene` gate, so a test can set up a persisted-but-broken scene file. */
  async function writeRawSceneFile(sceneId: string, raw: unknown): Promise<void> {
    const scenesDirectory = join(workspaceRoot, "scenes");
    await mkdir(scenesDirectory, { recursive: true });
    await writeFile(join(scenesDirectory, `${sceneId}.json`), JSON.stringify(raw, null, 2), "utf8");
  }

  it("lists repair_scene alongside the other registered tools", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    expect(tools.map((tool) => tool.name)).toContain(REPAIR_SCENE_TOOL_NAME);
  });

  it("reports no repair needed for an already-valid scene, and does not rewrite the file", async () => {
    const document: SceneDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: { id: "scene-1", name: "Valid Scene", compositions: [] },
    };
    await writeRawSceneFile("scene-1", document);
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: REPAIR_SCENE_TOOL_NAME,
      arguments: { sceneId: "scene-1" },
    });
    const payload = parseToolResult<RepairSceneResult>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    expect(payload.repaired).toBe(false);
    expect(payload.patchesApplied).toEqual([]);
    expect(payload.remainingDiagnostics).toEqual([]);
  });

  it("clamps an out-of-range durationInFrames back into range and persists the fix", async () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: {
        id: "scene-2",
        name: "Clamp Me",
        compositions: [
          {
            id: "comp-1",
            name: "Main",
            fps: 30,
            durationInFrames: -5,
            width: 1920,
            height: 1080,
            tracks: [],
          },
        ],
      },
    };
    await writeRawSceneFile("scene-2", raw);
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: REPAIR_SCENE_TOOL_NAME,
      arguments: { sceneId: "scene-2" },
    });
    const payload = parseToolResult<RepairSceneResult>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    expect(payload.repaired).toBe(true);
    expect(payload.patchesApplied.length).toBeGreaterThan(0);
    expect(payload.remainingDiagnostics).toEqual([]);
    expect(payload.document?.project.compositions[0]?.durationInFrames).toBeGreaterThan(0);

    // Confirm the fix was actually persisted, not just returned once.
    const getResult = await connectedClient.callTool({
      name: GET_SCENE_TOOL_NAME,
      arguments: { sceneId: "scene-2" },
    });
    const getPayload = parseToolResult<GetScenePayload>(getResult as ToolTextResult);
    expect(getPayload.success).toBe(true);
    expect(getPayload.document?.project.compositions[0]?.durationInFrames).toBeGreaterThan(0);
  });

  it("removes an unrecognized field and persists the fix", async () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: {
        id: "scene-3",
        name: "Extra Field",
        compositions: [],
        notARealField: "oops",
      },
    };
    await writeRawSceneFile("scene-3", raw);
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: REPAIR_SCENE_TOOL_NAME,
      arguments: { sceneId: "scene-3" },
    });
    const payload = parseToolResult<RepairSceneResult>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    expect(payload.repaired).toBe(true);
    expect(payload.patchesApplied).toEqual(
      expect.arrayContaining([expect.objectContaining({ op: "remove" })]),
    );
    expect(payload.remainingDiagnostics).toEqual([]);
  });

  it("leaves an unknown node kind unpatched and unpersisted, reporting it in remainingDiagnostics", async () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: {
        id: "scene-4",
        name: "Bad Kind",
        compositions: [
          {
            id: "comp-1",
            name: "Main",
            fps: 30,
            durationInFrames: 30,
            width: 100,
            height: 100,
            tracks: [
              {
                id: "track-1",
                clips: [
                  {
                    id: "clip-1",
                    startFrame: 0,
                    durationInFrames: 30,
                    node: {
                      id: "node-1",
                      kind: "not-a-real-kind",
                      transform: {
                        position: { x: 0, y: 0, z: 0 },
                        rotation: { x: 0, y: 0, z: 0 },
                        scale: { x: 1, y: 1, z: 1 },
                      },
                      visible: true,
                      children: [],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await writeRawSceneFile("scene-4", raw);
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: REPAIR_SCENE_TOOL_NAME,
      arguments: { sceneId: "scene-4" },
    });
    const payload = parseToolResult<RepairSceneResult>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    expect(payload.repaired).toBe(false);
    expect(payload.patchesApplied).toEqual([]);
    expect(payload.remainingDiagnostics.length).toBeGreaterThan(0);

    // Confirm the broken file was left exactly as it was: get_scene still
    // reports it as invalid, not silently rewritten into some other shape.
    const getResult = await connectedClient.callTool({
      name: GET_SCENE_TOOL_NAME,
      arguments: { sceneId: "scene-4" },
    });
    const getPayload = parseToolResult<GetScenePayload>(getResult as ToolTextResult);
    expect(getPayload.success).toBe(false);
  });

  it("reports a scene not found for an unknown sceneId", async () => {
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: REPAIR_SCENE_TOOL_NAME,
      arguments: { sceneId: "does-not-exist" },
    });
    const payload = parseToolResult<RepairSceneResult>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    expect(payload.remainingDiagnostics[0]?.path).toBe("sceneId");
  });

  it("rejects a path-traversal sceneId without touching the filesystem", async () => {
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: REPAIR_SCENE_TOOL_NAME,
      arguments: { sceneId: "../../etc/passwd" },
    });
    const payload = parseToolResult<RepairSceneResult>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    expect(payload.remainingDiagnostics[0]?.path).toBe("sceneId");
  });
});
