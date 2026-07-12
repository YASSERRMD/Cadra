import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  GenerationStore,
  VideoGenerationJob,
  VideoGenerationRequest,
  VideoGenerationStatus,
  VideoProvider,
} from "@cadra/providers";
import { createGenerationStore } from "@cadra/providers";
import type { SceneDocument } from "@cadra/schema";
import { parseScene } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASSET_REF_SCHEME } from "./asset-store.js";
import { ADD_GENERATED_CLIP_TOOL_NAME } from "./generation-clip-tools.js";
import { REGENERATE_CLIP_TOOL_NAME } from "./generation-regenerate-tools.js";
import { GET_GENERATION_STATUS_TOOL_NAME } from "./generation-tools.js";
import { createLogger } from "./logger.js";
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

interface AddGeneratedClipSuccessPayload {
  success: true;
  slotId: string;
  clipId: string;
  videoNodeId: string;
  trackId: string;
  requestHash: string;
  document: SceneDocument;
}

interface RegenerateClipSuccessPayload {
  success: true;
  slotId: string;
  videoNodeId: string;
  requestHash: string;
  document: SceneDocument;
}

type AddGeneratedClipPayload = AddGeneratedClipSuccessPayload | FailurePayload;
type RegenerateClipPayload = RegenerateClipSuccessPayload | FailurePayload;

/** A minimal, fully injectable fake `VideoProvider`: no real network call, ever, matching every other test in this codebase touching `@cadra/providers`. */
function createFakeProvider(name: string): {
  provider: VideoProvider;
  setNextStatus: (externalJobId: string, status: VideoGenerationStatus) => void;
} {
  const statusByJobId = new Map<string, VideoGenerationStatus>();
  let counter = 0;

  const provider: VideoProvider = {
    name,
    submit: vi.fn(async (_request: VideoGenerationRequest): Promise<VideoGenerationJob> => {
      counter += 1;
      const externalJobId = `${name}-job-${counter}`;
      statusByJobId.set(externalJobId, { status: "pending" });
      return { provider: name, externalJobId };
    }),
    poll: vi.fn(async (job: VideoGenerationJob): Promise<VideoGenerationStatus> => {
      return statusByJobId.get(job.externalJobId) ?? { status: "pending" };
    }),
  };

  return {
    provider,
    setNextStatus: (externalJobId, status) => statusByJobId.set(externalJobId, status),
  };
}

describe("Cadra MCP regenerate_clip tool", () => {
  let workspaceRoot: string;
  let clients: Client[] = [];
  let testHttpServers: Server[] = [];

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-generation-regenerate-tools-test-"));
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients = [];
    await rm(workspaceRoot, { recursive: true, force: true });
    await Promise.all(
      testHttpServers.map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    testHttpServers = [];
  });

  async function connectClient(store: GenerationStore): Promise<Client> {
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
      generation: { store },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);

    clients.push(newClient);
    return newClient;
  }

  /** Starts an in-process HTTP server serving `body` with `contentType`, mirroring `generation-clip-tools.test.ts`'s own fixture-server convention. */
  async function startFixtureServer(body: Buffer, contentType: string): Promise<string> {
    const testHttpServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    });
    testHttpServers.push(testHttpServer);
    await new Promise<void>((resolve) => testHttpServer.listen(0, "127.0.0.1", () => resolve()));
    const address = testHttpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the fixture server to bind to a network address.");
    }
    return `http://127.0.0.1:${address.port}/generated.mp4`;
  }

  async function createEmptyScene(connectedClient: Client, sceneId: string): Promise<void> {
    const result = await connectedClient.callTool({
      name: "create_scene",
      arguments: {
        sceneId,
        name: "Test Scene",
        composition: {
          id: "comp-1",
          name: "Main",
          fps: 30,
          durationInFrames: 300,
          width: 1920,
          height: 1080,
        },
      },
    });
    const payload = parseToolResult<{ success: boolean }>(result as ToolTextResult);
    expect(payload.success).toBe(true);
  }

  async function addGeneratedClip(
    connectedClient: Client,
    args: Record<string, unknown>,
  ): Promise<AddGeneratedClipSuccessPayload> {
    const result = await connectedClient.callTool({ name: ADD_GENERATED_CLIP_TOOL_NAME, arguments: args });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);
    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_generated_clip to succeed.");
    }
    return payload;
  }

  it("lists the regenerate_clip tool", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain(REGENERATE_CLIP_TOOL_NAME);
  });

  it("submits a new, independent request under the same slot id and resets the node's assetRef to the placeholder", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");
    await addGeneratedClip(connectedClient, {
      sceneId: "scene-1",
      compositionId: "comp-1",
      newTrackId: "track-1",
      clipId: "clip-1",
      videoNodeId: "video-1",
      startFrame: 0,
      durationInFrames: 90,
      providerName: "veo",
      request: { prompt: "A lighthouse beam sweeping across a stormy sea.", params: { seed: 1 } },
    });
    const firstRequestHash = store.getSlot("video-1")!.currentRequestHash;

    const result = await connectedClient.callTool({
      name: REGENERATE_CLIP_TOOL_NAME,
      arguments: { sceneId: "scene-1", videoNodeId: "video-1" },
    });
    const payload = parseToolResult<RegenerateClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected regenerate_clip to succeed.");
    }
    expect(payload.slotId).toBe("video-1");
    expect(payload.videoNodeId).toBe("video-1");
    // A genuinely new, independent dedup-cache entry - not the original
    // request's own hash reused.
    expect(payload.requestHash).not.toBe(firstRequestHash);
    expect(fake.provider.submit).toHaveBeenCalledTimes(2);

    // The node's own assetRef in the persisted document is the placeholder
    // again, keyed by the same slot id - proving get_generation_status's
    // own bindReadyGenerationsForScene pass will pick this node back up
    // once the new request resolves (see this module's own doc for why
    // this rewrite is not optional bookkeeping).
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "video" ? node.assetRef : undefined).toBe("cadra-generation://video-1");
    expect(parseScene(payload.document).success).toBe(true);

    // The original request's own cache entry is untouched, not discarded -
    // regeneration never mutates or removes a slot's previous entry.
    expect(store.getCacheEntry(firstRequestHash)).toBeDefined();
  });

  it("resets a node already bound to a real cadra-asset:// ref back to the placeholder, so the new result gets bound automatically once ready", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");
    await addGeneratedClip(connectedClient, {
      sceneId: "scene-1",
      compositionId: "comp-1",
      newTrackId: "track-1",
      clipId: "clip-1",
      videoNodeId: "video-1",
      startFrame: 0,
      durationInFrames: 90,
      providerName: "veo",
      request: { prompt: "First attempt." },
    });

    // Let the first generation resolve ready and bind onto the node, via
    // the same real call site a real agent would use.
    const firstUrl = await startFixtureServer(Buffer.from("first attempt bytes"), "video/mp4");
    fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: firstUrl });
    await store.refresh();
    const boundStatus = await connectedClient.callTool({
      name: GET_GENERATION_STATUS_TOOL_NAME,
      arguments: { slotId: "video-1", sceneId: "scene-1" },
    });
    const boundPayload = parseToolResult<{ resolution: { status: string }; bound: boolean }>(
      boundStatus as ToolTextResult,
    );
    expect(boundPayload.bound).toBe(true);

    const boundScene = await connectedClient.callTool({
      name: "get_scene",
      arguments: { sceneId: "scene-1" },
    });
    const boundDocument = parseToolResult<{ document: SceneDocument }>(
      boundScene as ToolTextResult,
    ).document;
    const boundNode = boundDocument.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    const boundAssetRef = boundNode.kind === "video" ? boundNode.assetRef : undefined;
    expect(boundAssetRef).toMatch(new RegExp(`^${ASSET_REF_SCHEME}`));

    // Regenerate the now-bound node. Without the assetRef reset this tool
    // performs, the node would keep pointing at boundAssetRef forever, and
    // the new job's eventual result would never be discovered by
    // findPendingGenerationNodes at all.
    const regenerateResult = await connectedClient.callTool({
      name: REGENERATE_CLIP_TOOL_NAME,
      arguments: { sceneId: "scene-1", videoNodeId: "video-1" },
    });
    const regeneratePayload = parseToolResult<RegenerateClipPayload>(
      regenerateResult as ToolTextResult,
    );
    expect(regeneratePayload.success).toBe(true);
    if (!regeneratePayload.success) {
      throw new Error("Expected regenerate_clip to succeed.");
    }
    const resetNode = regeneratePayload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(resetNode.kind === "video" ? resetNode.assetRef : undefined).toBe(
      "cadra-generation://video-1",
    );

    // Let the regenerated job resolve ready too, and verify the very next
    // status check binds the *new* output onto the node - the full
    // round-trip this tool's own rewrite exists to make possible.
    const secondUrl = await startFixtureServer(Buffer.from("regenerated bytes"), "video/mp4");
    fake.setNextStatus("veo-job-2", { status: "succeeded", outputUrl: secondUrl });
    await store.refresh();
    const reboundStatus = await connectedClient.callTool({
      name: GET_GENERATION_STATUS_TOOL_NAME,
      arguments: { slotId: "video-1", sceneId: "scene-1" },
    });
    const reboundPayload = parseToolResult<{ resolution: { status: string }; bound: boolean }>(
      reboundStatus as ToolTextResult,
    );
    expect(reboundPayload.resolution.status).toBe("ready");
    expect(reboundPayload.bound).toBe(true);

    const finalScene = await connectedClient.callTool({
      name: "get_scene",
      arguments: { sceneId: "scene-1" },
    });
    const finalDocument = parseToolResult<{ document: SceneDocument }>(
      finalScene as ToolTextResult,
    ).document;
    const finalNode = finalDocument.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    const finalAssetRef = finalNode.kind === "video" ? finalNode.assetRef : undefined;
    expect(finalAssetRef).toMatch(new RegExp(`^${ASSET_REF_SCHEME}`));
    // A genuinely different asset than the first attempt's own bound ref.
    expect(finalAssetRef).not.toBe(boundAssetRef);
  });

  it("honors explicit overrides instead of only randomizing the seed", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");
    await addGeneratedClip(connectedClient, {
      sceneId: "scene-1",
      compositionId: "comp-1",
      newTrackId: "track-1",
      clipId: "clip-1",
      videoNodeId: "video-1",
      startFrame: 0,
      durationInFrames: 90,
      providerName: "veo",
      request: { prompt: "Original prompt.", params: { seed: 42, aspectRatio: "16:9" } },
    });

    await connectedClient.callTool({
      name: REGENERATE_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        videoNodeId: "video-1",
        overrides: { prompt: "A completely different prompt." },
      },
    });

    expect(fake.provider.submit).toHaveBeenCalledTimes(2);
    const secondRequest = (fake.provider.submit as ReturnType<typeof vi.fn>).mock
      .calls[1]![0] as VideoGenerationRequest;
    expect(secondRequest.prompt).toBe("A completely different prompt.");
    // params.aspectRatio carries over unchanged (overrides.params was not
    // given at all here, so deriveRegeneratedRequest's own merge keeps the
    // previous request's own params entirely, aspectRatio included).
    expect(secondRequest.params.aspectRatio).toBe("16:9");
  });

  it("fails with a diagnostic for an unknown sceneId", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);

    const result = await connectedClient.callTool({
      name: REGENERATE_CLIP_TOOL_NAME,
      arguments: { sceneId: "no-such-scene", videoNodeId: "video-1" },
    });
    const payload = parseToolResult<RegenerateClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected regenerate_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("SCENE_NOT_FOUND");
  });

  it("fails with a diagnostic for a videoNodeId that does not exist in the scene", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: REGENERATE_CLIP_TOOL_NAME,
      arguments: { sceneId: "scene-1", videoNodeId: "no-such-node" },
    });
    const payload = parseToolResult<RegenerateClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected regenerate_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("NODE_NOT_FOUND");
  });

  it("fails with a diagnostic when the named node exists but is not a video node", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
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
        content: "Not a video.",
      },
    });

    const result = await connectedClient.callTool({
      name: REGENERATE_CLIP_TOOL_NAME,
      arguments: { sceneId: "scene-1", videoNodeId: "text-1" },
    });
    const payload = parseToolResult<RegenerateClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected regenerate_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("NOT_A_VIDEO_NODE");
  });

  it("fails with a diagnostic when the node's slot was never submitted against this server's own store", async () => {
    const fake = createFakeProvider("veo");
    const originalStore = createGenerationStore({ providers: { veo: fake.provider } });
    const originalClient = await connectClient(originalStore);
    await createEmptyScene(originalClient, "scene-1");
    await addGeneratedClip(originalClient, {
      sceneId: "scene-1",
      compositionId: "comp-1",
      newTrackId: "track-1",
      clipId: "clip-1",
      videoNodeId: "video-1",
      startFrame: 0,
      durationInFrames: 90,
      providerName: "veo",
      request: { prompt: "Submitted against a different store instance." },
    });

    // A second server, same on-disk workspace/scene, but a fresh store
    // that never saw this slot's own submitGeneration call - mirrors
    // bindReadyGenerations's own documented "submitted against a
    // different server process/store instance" scenario.
    const freshStore = createGenerationStore({ providers: { veo: fake.provider } });
    const freshClient = await connectClient(freshStore);

    const result = await freshClient.callTool({
      name: REGENERATE_CLIP_TOOL_NAME,
      arguments: { sceneId: "scene-1", videoNodeId: "video-1" },
    });
    const payload = parseToolResult<RegenerateClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected regenerate_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("UNKNOWN_SLOT");
    // Never submitted anything against the fresh store on this failed path.
    expect(fake.provider.submit).toHaveBeenCalledTimes(1);
  });
});
