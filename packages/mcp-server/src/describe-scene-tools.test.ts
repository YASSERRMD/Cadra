import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Camera, createComposition, createProject, Sequence, Shape } from "@cadra/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { DESCRIBE_SCENE_TOOL_NAME, describeScene } from "./describe-scene-tools.js";
import { createLogger } from "./logger.js";
import { CREATE_SCENE_TOOL_NAME, UPDATE_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

describe("describeScene", () => {
  it("outlines every composition/track/clip/node by id/kind/name only, recursively, omitting all other properties", () => {
    const child = Shape({ id: "child-box", name: "Child Box", material: { baseColor: [1, 0, 0, 1] } });
    const parent = Shape({ id: "parent-box" });
    parent.children.push(child);
    const camera = Camera({ id: "camera-1", transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } });

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 90,
      width: 1920,
      height: 1080,
      tracks: [
        { id: "track-shape", clips: [Sequence({ id: "clip-shape", from: 0, durationInFrames: 90, content: parent })] },
        { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 90, content: camera })] },
      ],
    });
    const project = createProject({ id: "scene-1", name: "Scene One", compositions: [composition] });

    const outline = describeScene("scene-1", 1, project);

    expect(outline).toEqual({
      sceneId: "scene-1",
      name: "Scene One",
      schemaVersion: 1,
      compositions: [
        {
          id: "comp-1",
          name: "Main",
          fps: 30,
          durationInFrames: 90,
          width: 1920,
          height: 1080,
          hasActiveCameraTrack: false,
          audioTrackCount: 0,
          tracks: [
            {
              id: "track-shape",
              clips: [
                {
                  id: "clip-shape",
                  startFrame: 0,
                  durationInFrames: 90,
                  hasTransition: false,
                  node: {
                    id: "parent-box",
                    kind: "mesh",
                    children: [
                      { id: "child-box", kind: "mesh", name: "Child Box", children: [] },
                    ],
                  },
                },
              ],
            },
            {
              id: "track-camera",
              clips: [
                {
                  id: "clip-camera",
                  startFrame: 0,
                  durationInFrames: 90,
                  hasTransition: false,
                  node: { id: "camera-1", kind: "camera", children: [] },
                },
              ],
            },
          ],
        },
      ],
    });
  });
});

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

describe("describe_scene MCP tool", () => {
  let workspaceRoot: string | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = undefined;
    }
  });

  async function connectClient(): Promise<Client> {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-describe-scene-test-"));
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const connectedClient = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), connectedClient.connect(clientTransport)]);
    client = connectedClient;
    return connectedClient;
  }

  it("lists describe_scene as a registered tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    expect(tools.some((tool) => tool.name === DESCRIBE_SCENE_TOOL_NAME)).toBe(true);
  });

  it("describes a real persisted scene end to end, much smaller than its full get_scene JSON", async () => {
    const connectedClient = await connectClient();
    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "describe-scene-test",
        name: "Describe scene test",
        composition: { id: "comp-1", name: "Main", fps: 30, durationInFrames: 90, width: 1920, height: 1080 },
      },
    });
    const shape = Shape({ id: "shape-1", material: { baseColor: [0.5, 0.5, 0.5, 1] } });
    const document = {
      schemaVersion: 1,
      project: createProject({
        id: "describe-scene-test",
        name: "Describe scene test",
        compositions: [
          createComposition({
            id: "comp-1",
            name: "Main",
            fps: 30,
            durationInFrames: 90,
            width: 1920,
            height: 1080,
            tracks: [{ id: "track-1", clips: [Sequence({ id: "clip-1", from: 0, durationInFrames: 90, content: shape })] }],
          }),
        ],
      }),
    };
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: { sceneId: "describe-scene-test", mode: "replace", document },
    });

    const result = await connectedClient.callTool({
      name: DESCRIBE_SCENE_TOOL_NAME,
      arguments: { sceneId: "describe-scene-test" },
    });
    const payload = parseToolResult<{ success: boolean; compositions?: unknown[] }>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    expect(payload.compositions).toHaveLength(1);
    // The outline must never leak per-property data like the material's own baseColor.
    expect(JSON.stringify(payload)).not.toContain("0.5");
  });

  it("returns an actionable diagnostic for an unknown scene id", async () => {
    const connectedClient = await connectClient();
    const result = await connectedClient.callTool({
      name: DESCRIBE_SCENE_TOOL_NAME,
      arguments: { sceneId: "no-such-scene" },
    });
    const payload = parseToolResult<{ success: boolean; message?: string }>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    expect(payload.message).toContain("no-such-scene");
  });
});
