import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOOK_PRESETS } from "@cadra/core";
import type { SceneDocument } from "@cadra/schema";
import { parseScene } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { APPLY_LOOK_PRESET_TOOL_NAME } from "./look-preset-tools.js";
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
  diagnostics: Array<{ path: string; message: string; code: string }>;
}

interface ApplyLookPresetSuccessPayload {
  success: true;
  lightNodeIds: string[];
  document: SceneDocument;
}

type ApplyLookPresetPayload = ApplyLookPresetSuccessPayload | FailurePayload;

describe("Cadra MCP apply_look_preset tool", () => {
  let workspaceRoot: string;
  let client: Client | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-look-preset-tools-test-"));
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

  it("lists the apply_look_preset tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain(APPLY_LOOK_PRESET_TOOL_NAME);
  });

  it("adds one track per preset light and sets postProcessing/environment from the cinematic preset", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: APPLY_LOOK_PRESET_TOOL_NAME,
      arguments: { sceneId: "scene-1", compositionId: "comp-1", presetName: "cinematic" },
    });
    const payload = parseToolResult<ApplyLookPresetPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected apply_look_preset to succeed.");
    }
    expect(payload.lightNodeIds).toHaveLength(LOOK_PRESETS.cinematic?.lights.length ?? 0);

    const composition = payload.document.project.compositions[0]!;
    expect(composition.tracks).toHaveLength(LOOK_PRESETS.cinematic?.lights.length ?? 0);
    for (const track of composition.tracks) {
      expect(track.clips[0]?.node.kind).toBe("light");
    }
    expect(composition.postProcessing).toEqual(LOOK_PRESETS.cinematic?.postProcessing);
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("applies dynamicAction (motionBlur, otherwise unreachable through this tool) and produces a scene that validates", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: APPLY_LOOK_PRESET_TOOL_NAME,
      arguments: { sceneId: "scene-1", compositionId: "comp-1", presetName: "dynamicAction" },
    });
    const payload = parseToolResult<ApplyLookPresetPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected apply_look_preset to succeed.");
    }

    const composition = payload.document.project.compositions[0]!;
    const effectTypes = composition.postProcessing?.effects.map((effect) => effect.type) ?? [];
    expect(effectTypes).toContain("motionBlur");
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("is deterministic: applying the same preset with the same idSeed twice produces the same light node ids", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");
    await createEmptyScene(connectedClient, "scene-2");

    const firstResult = await connectedClient.callTool({
      name: APPLY_LOOK_PRESET_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        presetName: "product",
        idSeed: "fixed-seed",
      },
    });
    const secondResult = await connectedClient.callTool({
      name: APPLY_LOOK_PRESET_TOOL_NAME,
      arguments: {
        sceneId: "scene-2",
        compositionId: "comp-1",
        presetName: "product",
        idSeed: "fixed-seed",
      },
    });
    const firstPayload = parseToolResult<ApplyLookPresetPayload>(firstResult as ToolTextResult);
    const secondPayload = parseToolResult<ApplyLookPresetPayload>(secondResult as ToolTextResult);

    expect(firstPayload.success).toBe(true);
    expect(secondPayload.success).toBe(true);
    if (!firstPayload.success || !secondPayload.success) {
      throw new Error("Expected both apply_look_preset calls to succeed.");
    }
    expect(secondPayload.lightNodeIds).toEqual(firstPayload.lightNodeIds);
  });

  it("fails with a diagnostic for an unknown presetName", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: APPLY_LOOK_PRESET_TOOL_NAME,
      arguments: { sceneId: "scene-1", compositionId: "comp-1", presetName: "not-a-real-preset" },
    });

    // presetName is a z.enum of LOOK_PRESETS' own keys, so an unknown value
    // is rejected by MCP's own input-schema validation before this tool's
    // handler ever runs (isError, not this tool's own JSON failure shape).
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("fails with a diagnostic for an unknown sceneId", async () => {
    const connectedClient = await connectClient();

    const result = await connectedClient.callTool({
      name: APPLY_LOOK_PRESET_TOOL_NAME,
      arguments: { sceneId: "no-such-scene", compositionId: "comp-1", presetName: "cinematic" },
    });
    const payload = parseToolResult<ApplyLookPresetPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected apply_look_preset to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("SCENE_NOT_FOUND");
  });

  it("fails with a diagnostic for an unknown compositionId", async () => {
    const connectedClient = await connectClient();
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: APPLY_LOOK_PRESET_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "no-such-composition",
        presetName: "cinematic",
      },
    });
    const payload = parseToolResult<ApplyLookPresetPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected apply_look_preset to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("COMPOSITION_NOT_FOUND");
  });
});
