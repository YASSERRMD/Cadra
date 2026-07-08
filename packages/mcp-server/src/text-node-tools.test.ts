import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SceneDocument } from "@cadra/schema";
import { parseScene } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { CREATE_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";
import { ADD_TEXT_NODE_TOOL_NAME } from "./text-node-tools.js";

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
  diagnostics: Array<{ path: string; message: string; code: string }>;
}

interface AddTextNodeSuccessPayload {
  success: true;
  clipId: string;
  textNodeId: string;
  trackId: string;
  document: SceneDocument;
}

type AddTextNodePayload = AddTextNodeSuccessPayload | FailurePayload;

describe("Cadra MCP add_text_node tool", () => {
  let workspaceRoot: string;
  let client: Client | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-text-node-tools-test-"));
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

  async function createEmptyScene(connectedClient: Client, sceneId: string): Promise<void> {
    const result = await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId,
        name: "Test Scene",
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
    const payload = parseToolResult<{ success: boolean }>(result as ToolTextResult);
    expect(payload.success).toBe(true);
  }

  it("lists the add_text_node tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain(ADD_TEXT_NODE_TOOL_NAME);
  });

  it("inserts a plain text node onto a brand-new track", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "Hello, World",
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_text_node to succeed.");
    }
    expect(payload.trackId).toBe("track-1");
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind).toBe("text");
    expect(node.kind === "text" ? node.content : undefined).toBe("Hello, World");
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("round-trips a kinetic stagger, a glow, and a custom color onto the new node", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "CADRA",
        fontSize: 96,
        color: [1, 1, 1, 1],
        stagger: {
          preset: "fadeInUp",
          grouping: "character",
          startFrame: 0,
          delayFrames: 3,
          durationFrames: 18,
        },
        glow: { radius: 0.08, color: [0.4, 0.7, 1, 1] },
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_text_node to succeed.");
    }
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "text" ? node.stagger?.preset : undefined).toBe("fadeInUp");
    expect(node.kind === "text" ? node.glow?.radius : undefined).toBe(0.08);
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("applies a typePreset's own fontSize/stagger onto the new node", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "CADRA",
        typePreset: "title",
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_text_node to succeed.");
    }
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "text" ? node.fontSize : undefined).toBe(96);
    expect(node.kind === "text" ? node.stagger?.preset : undefined).toBe("fadeInUp");
    expect(node.kind === "text" ? node.stagger?.grouping : undefined).toBe("word");
    expect(node.kind === "text" ? node.glow?.radius : undefined).toBe(0.06);
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("lets an explicit field override typePreset's own value for that one field", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "CADRA",
        typePreset: "title",
        fontSize: 150,
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_text_node to succeed.");
    }
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    // The explicit fontSize wins, but the rest of the "title" preset (its
    // own stagger/glow) still applies.
    expect(node.kind === "text" ? node.fontSize : undefined).toBe(150);
    expect(node.kind === "text" ? node.stagger?.preset : undefined).toBe("fadeInUp");
  });

  it("rejects an unknown typePreset name", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "CADRA",
        typePreset: "not-a-real-preset",
      },
    });

    // typePreset is a z.enum of TYPE_PRESETS' own keys, so an unknown value
    // is rejected by MCP's own input-schema validation before this tool's
    // handler ever runs (isError, not this tool's own JSON failure shape).
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("accepts real Arabic (right-to-left) content as plain text", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-arabic",
        startFrame: 0,
        durationInFrames: 90,
        content: "مرحبا بالعالم",
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_text_node to succeed.");
    }
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "text" ? node.content : undefined).toBe("مرحبا بالعالم");
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("combines typePreset with real Arabic content, since TYPE_PRESETS groups by word/line (reading-order-safe), never character/grapheme (Phase 73 task 4)", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-arabic-lower-third",
        startFrame: 0,
        durationInFrames: 90,
        content: "مرحبا بالعالم",
        typePreset: "lowerThird",
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_text_node to succeed.");
    }
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "text" ? node.content : undefined).toBe("مرحبا بالعالم");
    expect(node.kind === "text" ? node.stagger?.grouping : undefined).toBe("word");
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("appends a second text node onto an existing track via existingTrackId", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 45,
        content: "First",
      },
    });

    const secondResult = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        existingTrackId: "track-1",
        clipId: "clip-2",
        textNodeId: "text-2",
        startFrame: 45,
        durationInFrames: 45,
        content: "Second",
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(secondResult as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected the second add_text_node call to succeed.");
    }
    const composition = payload.document.project.compositions[0]!;
    expect(composition.tracks).toHaveLength(1);
    expect(composition.tracks[0]!.clips).toHaveLength(2);
  });

  it("rejects a textNodeId that already exists in the project", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "First",
      },
    });

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-2",
        clipId: "clip-2",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "Colliding id",
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_text_node to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("DUPLICATE_NODE_ID");
  });

  it("fails with a diagnostic for an unknown sceneId", async () => {
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: ADD_TEXT_NODE_TOOL_NAME,
      arguments: {
        sceneId: "no-such-scene",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        textNodeId: "text-1",
        startFrame: 0,
        durationInFrames: 90,
        content: "Anything",
      },
    });
    const payload = parseToolResult<AddTextNodePayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_text_node to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("SCENE_NOT_FOUND");
  });
});
