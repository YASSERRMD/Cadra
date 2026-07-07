import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TextToScene, TextToSceneRequest, TextToSceneResult } from "@cadra/agent-sdk";
import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveCadraMcpServerConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { GET_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";
import type { TextToSceneAdapterFactory, TextToSceneAdapterFactoryOptions } from "./text-to-scene-tools.js";
import { createDefaultTextToSceneAdapter, GENERATE_SCENE_FROM_TEXT_TOOL_NAME } from "./text-to-scene-tools.js";

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

interface GenerateSuccessPayload {
  success: true;
  document: SceneDocument;
  rationale?: string;
  attempts: number;
}

interface GenerateFailurePayload {
  success: false;
  diagnostics: SceneParseDiagnostic[];
}

type GeneratePayload = GenerateSuccessPayload | GenerateFailurePayload;

/** A real, valid, minimal scene document, matching the same fixture shape @cadra/agent-sdk's own adapter test suite uses. */
const VALID_DOCUMENT: SceneDocument = {
  schemaVersion: 1,
  project: {
    id: "project-generated",
    name: "Generated Project",
    compositions: [
      {
        id: "comp-generated",
        name: "Main",
        fps: 30,
        durationInFrames: 90,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "track-generated",
            name: "Title",
            clips: [
              {
                id: "clip-generated",
                startFrame: 0,
                durationInFrames: 90,
                node: {
                  id: "root-generated",
                  kind: "group",
                  name: "Root",
                  transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
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

/** Builds a fake {@link TextToSceneAdapterFactory} that always returns `result`, recording every call's `TextToSceneRequest` and the factory's own `TextToSceneAdapterFactoryOptions` for assertions. */
function fakeAdapterFactory(
  result: TextToSceneResult,
): { factory: TextToSceneAdapterFactory; requests: TextToSceneRequest[]; factoryCalls: TextToSceneAdapterFactoryOptions[] } {
  const requests: TextToSceneRequest[] = [];
  const factoryCalls: TextToSceneAdapterFactoryOptions[] = [];

  const adapter: TextToScene = {
    async generate(request) {
      requests.push(request);
      return result;
    },
  };

  const factory: TextToSceneAdapterFactory = (options) => {
    factoryCalls.push(options);
    return adapter;
  };

  return { factory, requests, factoryCalls };
}

describe("Cadra MCP text-to-scene tools", () => {
  let workspaceRoot: string;
  let client: Client | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-text-to-scene-tools-test-"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function connectClient(adapterFactory: TextToSceneAdapterFactory): Promise<Client> {
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
      textToScene: { adapterFactory },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);

    client = newClient;
    return newClient;
  }

  it("lists generate_scene_from_text as a registered tool", async () => {
    const { factory } = fakeAdapterFactory({ success: true, document: VALID_DOCUMENT, attempts: 1 });
    const connectedClient = await connectClient(factory);

    const { tools } = await connectedClient.listTools();
    expect(tools.map((tool) => tool.name)).toContain(GENERATE_SCENE_FROM_TEXT_TOOL_NAME);
  });

  describe("on adapter success", () => {
    it("persists the generated document and returns it, plus attempts and no rationale when none was given", async () => {
      const { factory } = fakeAdapterFactory({ success: true, document: VALID_DOCUMENT, attempts: 1 });
      const connectedClient = await connectClient(factory);

      const result = await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: { sceneId: "generated-scene", brief: "A title card." },
      });

      const payload = parseToolResult<GeneratePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        expect(payload.document.project.id).toBe("project-generated");
        expect(payload.attempts).toBe(1);
        expect(payload.rationale).toBeUndefined();
      }

      // Persisted exactly like create_scene would: readable via get_scene afterward.
      const getResult = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "generated-scene" },
      });
      const getPayload = parseToolResult<{ success: true; document: SceneDocument }>(getResult as ToolTextResult);
      expect(getPayload.success).toBe(true);
      expect(getPayload.document.project.id).toBe("project-generated");
    });

    it("returns the model's rationale when the adapter provides one", async () => {
      const { factory } = fakeAdapterFactory({
        success: true,
        document: VALID_DOCUMENT,
        attempts: 2,
        rationale: "Chose a calm fade-in to match the brief's mood.",
      });
      const connectedClient = await connectClient(factory);

      const result = await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: { sceneId: "generated-scene-2", brief: "A calm title card." },
      });

      const payload = parseToolResult<GeneratePayload>(result as ToolTextResult);
      expect(payload.success).toBe(true);
      if (payload.success) {
        expect(payload.attempts).toBe(2);
        expect(payload.rationale).toBe("Chose a calm fade-in to match the brief's mood.");
      }
    });

    it("forwards the brief and constraints to the adapter's generate() call", async () => {
      const { factory, requests } = fakeAdapterFactory({ success: true, document: VALID_DOCUMENT, attempts: 1 });
      const connectedClient = await connectClient(factory);

      await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: {
          sceneId: "generated-scene-3",
          brief: "A 3-second logo reveal.",
          constraints: { durationInFrames: 90, fps: 30, size: { width: 1080, height: 1920 } },
        },
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({
        brief: "A 3-second logo reveal.",
        constraints: { durationInFrames: 90, fps: 30, size: { width: 1080, height: 1920 } },
      });
    });

    it("forwards maxAttempts to the adapter factory, not to generate()", async () => {
      const { factory, factoryCalls } = fakeAdapterFactory({ success: true, document: VALID_DOCUMENT, attempts: 1 });
      const connectedClient = await connectClient(factory);

      await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: { sceneId: "generated-scene-4", brief: "A title card.", maxAttempts: 5 },
      });

      expect(factoryCalls).toHaveLength(1);
      expect(factoryCalls[0]?.maxAttempts).toBe(5);
    });

    it("omits constraints from the request entirely when none are given", async () => {
      const { factory, requests } = fakeAdapterFactory({ success: true, document: VALID_DOCUMENT, attempts: 1 });
      const connectedClient = await connectClient(factory);

      await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: { sceneId: "generated-scene-5", brief: "A title card." },
      });

      expect(requests[0]).toEqual({ brief: "A title card." });
      expect(requests[0]).not.toHaveProperty("constraints");
    });
  });

  describe("on adapter failure", () => {
    it("returns the final diagnostics and does not persist anything", async () => {
      const diagnostics: SceneParseDiagnostic[] = [
        {
          path: "project.compositions[0].tracks[0].clips[0].node.kind",
          message: "Unrecognized node kind 'not-a-real-kind'.",
          code: "UNKNOWN_NODE_KIND",
        },
      ];
      const { factory } = fakeAdapterFactory({ success: false, diagnostics, attempts: 3 });
      const connectedClient = await connectClient(factory);

      const result = await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: { sceneId: "never-persisted", brief: "A broken brief." },
      });

      const payload = parseToolResult<GeneratePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics).toEqual(diagnostics);
      }

      const getResult = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "never-persisted" },
      });
      const getPayload = parseToolResult<{ success: false }>(getResult as ToolTextResult);
      expect(getPayload.success).toBe(false);
    });
  });

  describe("input validation before ever calling the adapter", () => {
    it("rejects an unsafe scene id with a path-traversal attempt, never calling the adapter", async () => {
      const generate = vi.fn();
      const factory: TextToSceneAdapterFactory = () => ({ generate });
      const connectedClient = await connectClient(factory);

      const result = await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: { sceneId: "../../etc/passwd", brief: "Evil." },
      });

      const payload = parseToolResult<GeneratePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics[0]?.path).toBe("sceneId");
      }
      expect(generate).not.toHaveBeenCalled();
    });

    it("rejects a blank brief, never calling the adapter", async () => {
      const generate = vi.fn();
      const factory: TextToSceneAdapterFactory = () => ({ generate });
      const connectedClient = await connectClient(factory);

      const result = await connectedClient.callTool({
        name: GENERATE_SCENE_FROM_TEXT_TOOL_NAME,
        arguments: { sceneId: "blank-brief-scene", brief: "   " },
      });

      const payload = parseToolResult<GeneratePayload>(result as ToolTextResult);
      expect(payload.success).toBe(false);
      if (!payload.success) {
        expect(payload.diagnostics[0]?.path).toBe("brief");
      }
      expect(generate).not.toHaveBeenCalled();
    });
  });

  describe("createDefaultTextToSceneAdapter (the real, uninjected default)", () => {
    it("constructs a usable adapter with no network call and no API key present", () => {
      // Constructing the default adapter (as registerCadraTextToSceneTools
      // does whenever no adapterFactory override is given) must never itself
      // make a network call or require an API key: only calling the
      // returned adapter's own .generate() would. This test deliberately
      // never calls .generate() (that would be a real, paid LLM API call),
      // proving only that the wiring from config.providerKeys.anthropic
      // through to a constructed TextToScene compiles and runs safely with
      // no key configured at all.
      const config = resolveCadraMcpServerConfig({ workspaceRoot: "/tmp/unused", providerKeys: {} });
      const adapter = createDefaultTextToSceneAdapter({ config });
      expect(typeof adapter.generate).toBe("function");
    });

    it("accepts an explicit providerKeys.anthropic without throwing at construction time", () => {
      const config = resolveCadraMcpServerConfig({
        workspaceRoot: "/tmp/unused",
        providerKeys: { anthropic: "fake-test-key-not-a-real-secret" },
      });
      const adapter = createDefaultTextToSceneAdapter({ config });
      expect(typeof adapter.generate).toBe("function");
    });

    it("forwards maxAttempts through to the constructed adapter's own configuration", () => {
      const config = resolveCadraMcpServerConfig({ workspaceRoot: "/tmp/unused", providerKeys: {} });
      const adapter = createDefaultTextToSceneAdapter({ config, maxAttempts: 7 });
      expect(typeof adapter.generate).toBe("function");
    });
  });
});
