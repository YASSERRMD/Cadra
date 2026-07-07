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
import { GENERATION_REF_SCHEME } from "./generation-asset-binding.js";
import { ADD_GENERATED_CLIP_TOOL_NAME } from "./generation-clip-tools.js";
import { GET_GENERATION_STATUS_TOOL_NAME } from "./generation-tools.js";
import { createLogger } from "./logger.js";
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

interface AddGeneratedClipSuccessPayload {
  success: true;
  slotId: string;
  clipId: string;
  videoNodeId: string;
  trackId: string;
  requestHash: string;
  document: SceneDocument;
}

type AddGeneratedClipPayload = AddGeneratedClipSuccessPayload | FailurePayload;

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

describe("Cadra MCP add_generated_clip tool", () => {
  let workspaceRoot: string;
  let client: Client | undefined;
  let testHttpServers: Server[] = [];

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-generation-clip-tools-test-"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
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

    client = newClient;
    return newClient;
  }

  /** Starts an in-process HTTP server serving `body` with `contentType`, mirroring every other test in this package's own fixture-server convention (a real, local, non-internet URL). */
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
      name: CREATE_SCENE_TOOL_NAME,
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

  it("lists the add_generated_clip tool", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toContain(ADD_GENERATED_CLIP_TOOL_NAME);
  });

  it("submits a generation, inserts a new track and clip, and returns immediately without blocking on completion", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "A lighthouse beam sweeping across a stormy sea." },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_generated_clip to succeed.");
    }
    expect(payload.slotId).toBe("video-1");
    expect(payload.clipId).toBe("clip-1");
    expect(payload.videoNodeId).toBe("video-1");
    expect(payload.trackId).toBe("track-1");
    expect(payload.requestHash).toEqual(expect.any(String));

    const composition = payload.document.project.compositions[0]!;
    expect(composition.tracks).toHaveLength(1);
    const clip = composition.tracks[0]!.clips[0]!;
    expect(clip.id).toBe("clip-1");
    expect(clip.startFrame).toBe(0);
    expect(clip.durationInFrames).toBe(90);
    expect(clip.node.kind).toBe("video");
    expect(clip.node.kind === "video" ? clip.node.assetRef : undefined).toBe(
      `${GENERATION_REF_SCHEME}video-1`,
    );

    // Never blocked on the generation actually finishing: the fake provider's
    // job is still "pending" at this point (never advanced to "succeeded").
    expect(fake.provider.submit).toHaveBeenCalledTimes(1);
    expect(store.getSlotStatus("video-1").status).toBe("pending");
  });

  it("appends a second clip onto an existing track via existingTrackId", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Shot one." },
      },
    });

    const secondResult = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        existingTrackId: "track-1",
        clipId: "clip-2",
        videoNodeId: "video-2",
        startFrame: 90,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Shot two." },
        transitionIn: { type: "crossDissolve", durationInFrames: 15 },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(secondResult as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected the second add_generated_clip call to succeed.");
    }
    expect(payload.trackId).toBe("track-1");

    const composition = payload.document.project.compositions[0]!;
    expect(composition.tracks).toHaveLength(1);
    expect(composition.tracks[0]!.clips).toHaveLength(2);
    const secondClip = composition.tracks[0]!.clips[1]!;
    expect(secondClip.id).toBe("clip-2");
    expect(secondClip.transitionIn).toEqual({ type: "crossDissolve", durationInFrames: 15 });
  });

  it("round-trips blendMode and maskRef onto the new VideoNode", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "A masked, additively-blended generated shot." },
        blendMode: "multiply",
        maskRef: "cadra-asset://mask-hash",
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected add_generated_clip to succeed.");
    }
    const node = payload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
    expect(node.kind === "video" ? node.blendMode : undefined).toBe("multiply");
    expect(node.kind === "video" ? node.maskRef : undefined).toBe("cadra-asset://mask-hash");
    expect(parseScene(payload.document).success).toBe(true);
  });

  it("fails with a diagnostic for an unknown sceneId", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "no-such-scene",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Anything." },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_generated_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("SCENE_NOT_FOUND");
  });

  it("fails with a diagnostic for an unknown compositionId", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "no-such-composition",
        newTrackId: "track-1",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Anything." },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_generated_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("COMPOSITION_NOT_FOUND");
  });

  it("fails with a diagnostic for an unknown existingTrackId", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        existingTrackId: "no-such-track",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Anything." },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_generated_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("TRACK_NOT_FOUND");
  });

  it("fails with a diagnostic when both existingTrackId and newTrackId are given", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        existingTrackId: "track-1",
        newTrackId: "track-2",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Anything." },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_generated_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("MISSING_REQUIRED_FIELD");
  });

  it("rejects a videoNodeId that already exists in the project", async () => {
    const fake = createFakeProvider("veo");
    const store = createGenerationStore({ providers: { veo: fake.provider } });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Shot one." },
      },
    });

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-2",
        clipId: "clip-2",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "veo",
        request: { prompt: "Shot two, colliding id." },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_generated_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("DUPLICATE_NODE_ID");
  });

  it("fails cleanly (not an unhandled error) with a diagnostic for a providerName not registered with the store", async () => {
    const store = createGenerationStore({ providers: {} });
    const connectedClient = await connectClient(store);
    await createEmptyScene(connectedClient, "scene-1");

    const result = await connectedClient.callTool({
      name: ADD_GENERATED_CLIP_TOOL_NAME,
      arguments: {
        sceneId: "scene-1",
        compositionId: "comp-1",
        newTrackId: "track-1",
        clipId: "clip-1",
        videoNodeId: "video-1",
        startFrame: 0,
        durationInFrames: 90,
        providerName: "not-a-registered-provider",
        request: { prompt: "Anything." },
      },
    });
    const payload = parseToolResult<AddGeneratedClipPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
    if (payload.success) {
      throw new Error("Expected add_generated_clip to fail.");
    }
    expect(payload.diagnostics[0]!.code).toBe("GENERATION_SUBMIT_FAILED");
    expect(payload.diagnostics[0]!.message).toContain("not-a-registered-provider");
  });

  describe("task 6: assembling a two-shot sequence from generated clips with a transition", () => {
    it("both slots resolve ready, both nodes' refs get rewritten to real cadra-asset:// refs, and the final scene is valid", async () => {
      const fake = createFakeProvider("veo");
      const store = createGenerationStore({ providers: { veo: fake.provider } });
      const connectedClient = await connectClient(store);
      await createEmptyScene(connectedClient, "scene-1");

      // First shot: a brand-new track.
      const firstResult = await connectedClient.callTool({
        name: ADD_GENERATED_CLIP_TOOL_NAME,
        arguments: {
          sceneId: "scene-1",
          compositionId: "comp-1",
          newTrackId: "track-1",
          clipId: "clip-1",
          videoNodeId: "video-1",
          startFrame: 0,
          durationInFrames: 90,
          providerName: "veo",
          request: { prompt: "A wide establishing shot of a coastal lighthouse at dusk." },
        },
      });
      const firstPayload = parseToolResult<AddGeneratedClipPayload>(firstResult as ToolTextResult);
      expect(firstPayload.success).toBe(true);

      // Second shot: same track, placed after the first, with a transitionIn.
      const secondResult = await connectedClient.callTool({
        name: ADD_GENERATED_CLIP_TOOL_NAME,
        arguments: {
          sceneId: "scene-1",
          compositionId: "comp-1",
          existingTrackId: "track-1",
          clipId: "clip-2",
          videoNodeId: "video-2",
          startFrame: 90,
          durationInFrames: 90,
          providerName: "veo",
          request: { prompt: "A close-up of the lighthouse beam sweeping across the water." },
          transitionIn: { type: "crossDissolve", durationInFrames: 20 },
        },
      });
      const secondPayload = parseToolResult<AddGeneratedClipPayload>(
        secondResult as ToolTextResult,
      );
      expect(secondPayload.success).toBe(true);
      if (!secondPayload.success) {
        throw new Error("Expected the second add_generated_clip call to succeed.");
      }

      // Both slots still generating: no cadra-asset:// refs yet.
      const beforeReadyNode1 =
        secondPayload.document.project.compositions[0]!.tracks[0]!.clips[0]!.node;
      const beforeReadyNode2 =
        secondPayload.document.project.compositions[0]!.tracks[0]!.clips[1]!.node;
      expect(beforeReadyNode1.kind === "video" ? beforeReadyNode1.assetRef : undefined).toBe(
        `${GENERATION_REF_SCHEME}video-1`,
      );
      expect(beforeReadyNode2.kind === "video" ? beforeReadyNode2.assetRef : undefined).toBe(
        `${GENERATION_REF_SCHEME}video-2`,
      );

      // Let both slots resolve to "ready" via the fake provider.
      const firstShotUrl = await startFixtureServer(
        Buffer.from("fake mp4 bytes for shot one"),
        "video/mp4",
      );
      const secondShotUrl = await startFixtureServer(
        Buffer.from("fake mp4 bytes for shot two"),
        "video/mp4",
      );
      fake.setNextStatus("veo-job-1", { status: "succeeded", outputUrl: firstShotUrl });
      fake.setNextStatus("veo-job-2", { status: "succeeded", outputUrl: secondShotUrl });
      await store.refresh();

      // Drive the binding/status-check call site: get_generation_status,
      // passing sceneId (an agent naturally polling on a slot id
      // add_generated_clip returned, for the scene it just inserted it
      // into). This is the Phase 36 "automatically on completion" trigger:
      // because sceneId is given, this call also binds *every* one of this
      // scene's now-ready generation slots onto their real asset refs (not
      // just the one slotId this particular call happens to be checking)
      // and persists that rewrite, as a side effect of the status check.
      // The very first such call for this scene binds both nodes at once;
      // a second call finds nothing new left to bind (bound: false is
      // correct there, since video-2 was already bound a moment earlier).
      const status1 = await connectedClient.callTool({
        name: GET_GENERATION_STATUS_TOOL_NAME,
        arguments: { slotId: "video-1", sceneId: "scene-1" },
      });
      const status2 = await connectedClient.callTool({
        name: GET_GENERATION_STATUS_TOOL_NAME,
        arguments: { slotId: "video-2", sceneId: "scene-1" },
      });
      const status1Payload = parseToolResult<{ resolution: { status: string }; bound: boolean }>(
        status1 as ToolTextResult,
      );
      const status2Payload = parseToolResult<{ resolution: { status: string }; bound: boolean }>(
        status2 as ToolTextResult,
      );
      expect(status1Payload.resolution.status).toBe("ready");
      expect(status2Payload.resolution.status).toBe("ready");
      expect(status1Payload.bound).toBe(true);

      // Read the scene back and assert the final document: valid
      // (parseScene succeeds), has two clips on the one track with the
      // expected transitionIn, and both VideoNodes reference real (not
      // cadra-generation://) asset refs.
      const readBack = await connectedClient.callTool({
        name: "get_scene",
        arguments: { sceneId: "scene-1" },
      });
      const readBackPayload = parseToolResult<{ success: true; document: SceneDocument }>(
        readBack as ToolTextResult,
      );
      expect(readBackPayload.success).toBe(true);

      const finalValidation = parseScene(readBackPayload.document);
      expect(finalValidation.success).toBe(true);

      const finalComposition = readBackPayload.document.project.compositions[0]!;
      expect(finalComposition.tracks).toHaveLength(1);
      expect(finalComposition.tracks[0]!.clips).toHaveLength(2);

      const [finalClip1, finalClip2] = finalComposition.tracks[0]!.clips;
      expect(finalClip1!.transitionIn).toBeUndefined();
      expect(finalClip2!.transitionIn).toEqual({ type: "crossDissolve", durationInFrames: 20 });

      const finalNode1 = finalClip1!.node;
      const finalNode2 = finalClip2!.node;
      expect(finalNode1.kind).toBe("video");
      expect(finalNode2.kind).toBe("video");
      const finalAssetRef1 = finalNode1.kind === "video" ? finalNode1.assetRef : undefined;
      const finalAssetRef2 = finalNode2.kind === "video" ? finalNode2.assetRef : undefined;
      expect(finalAssetRef1).toBeDefined();
      expect(finalAssetRef2).toBeDefined();
      expect(finalAssetRef1).not.toContain(GENERATION_REF_SCHEME);
      expect(finalAssetRef2).not.toContain(GENERATION_REF_SCHEME);
      expect(finalAssetRef1).toMatch(new RegExp(`^${ASSET_REF_SCHEME}`));
      expect(finalAssetRef2).toMatch(new RegExp(`^${ASSET_REF_SCHEME}`));
      expect(finalAssetRef1).not.toBe(finalAssetRef2);
    });
  });
});
