import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import {
  GET_RENDER_OUTPUT_TOOL_NAME,
  GET_RENDER_STATUS_TOOL_NAME,
  RENDER_SCENE_TOOL_NAME,
} from "./render-tools.js";
import { CREATE_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

/** Shape every tool in this module returns its JSON payload as: one text content block. */
interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content).toBeDefined();
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

interface FailurePayload {
  success: false;
  message: string;
}

describe("Cadra MCP render tools", () => {
  let workspaceRoot: string;
  let client: Client | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-tools-test-"));
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

  it("lists every registered render tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        RENDER_SCENE_TOOL_NAME,
        GET_RENDER_STATUS_TOOL_NAME,
        GET_RENDER_OUTPUT_TOOL_NAME,
      ]),
    );
  });

  describe("render_scene validation", () => {
    it("rejects a malformed scene id before ever touching the filesystem", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({
        name: RENDER_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "../../etc/passwd",
          compositionId: "comp-1",
          seed: "seed",
          format: "mp4",
          bitrate: 1_000_000,
        },
      });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("letters, digits, hyphens");
    });

    it("rejects a scene id that does not exist in this workspace", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({
        name: RENDER_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "no-such-scene",
          compositionId: "comp-1",
          seed: "seed",
          format: "mp4",
          bitrate: 1_000_000,
        },
      });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("no-such-scene");
    });

    it("rejects a composition id that does not exist within an existing scene", async () => {
      const connectedClient = await connectClient();
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-1",
          name: "Scene One",
          composition: {
            id: "comp-real",
            name: "Main",
            fps: 30,
            durationInFrames: 10,
            width: 64,
            height: 64,
          },
        },
      });

      const result = await connectedClient.callTool({
        name: RENDER_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "scene-1",
          compositionId: "comp-does-not-exist",
          seed: "seed",
          format: "mp4",
          bitrate: 1_000_000,
        },
      });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("comp-does-not-exist");
      expect(payload.message).toContain("comp-real");
    });
  });

  describe("get_render_status / get_render_output for unknown jobs", () => {
    it("get_render_status reports failure for an unknown job id", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({
        name: GET_RENDER_STATUS_TOOL_NAME,
        arguments: { jobId: "no-such-job" },
      });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("no-such-job");
    });

    it("get_render_output reports failure for an unknown job id", async () => {
      const connectedClient = await connectClient();
      const result = await connectedClient.callTool({
        name: GET_RENDER_OUTPUT_TOOL_NAME,
        arguments: { jobId: "no-such-job" },
      });
      const payload = parseToolResult<FailurePayload>(result as ToolTextResult);

      expect(payload.success).toBe(false);
      expect(payload.message).toContain("no-such-job");
    });
  });
});
