import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Camera,
  type Composition,
  createComposition,
  createProject,
  hashAssetBytes,
  Image,
  Light,
  type Project,
  Sequence,
  Shape,
} from "@cadra/core";
import { readMp4FragmentedDurationTicks, readMp4TrackTimescale } from "@cadra/encode";
import type { SceneDocument } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { ASSET_REF_SCHEME } from "./asset-store.js";
import { UPLOAD_ASSET_TOOL_NAME } from "./asset-tools.js";
import { createLogger } from "./logger.js";
import { GET_RENDER_OUTPUT_TOOL_NAME, GET_RENDER_STATUS_TOOL_NAME, RENDER_SCENE_TOOL_NAME } from "./render-tools.js";
import {
  CREATE_SCENE_TOOL_NAME,
  GET_SCENE_TOOL_NAME,
  UPDATE_SCENE_TOOL_NAME,
} from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

/**
 * A full, real, end-to-end agent loop against this server's actual tools,
 * exercised in-process against one live `McpServer` instance: create a
 * scene, upload an asset both by raw bytes and by URL (the latter served by
 * an in-process test HTTP server, so this never depends on real internet
 * access), reference the by-bytes asset's ref from a follow-up update_scene
 * patch, render the scene, poll get_render_status until done, and fetch the
 * finished file via get_render_output, then validate the file is a real,
 * valid MP4 with the expected container-level duration.
 *
 * Kept small and fast, mirroring `render-job.e2e.test.ts`'s own guard and
 * sizing rationale exactly: a handful of frames, small resolution, real
 * Chromium, real WebCodecs, real mp4-muxer, guarded to skip cleanly (never
 * hang or fail the suite) when no real Chromium is available in this
 * environment.
 *
 * The rendered composition itself deliberately uses the same proven
 * lit-box pattern `render-job.e2e.test.ts`/`render-composition-headless-
 * server.e2e.test.ts` already use (shape + camera + ambient/directional
 * lights), not the uploaded image asset: `packages/renderer` does not yet
 * implement an `image` node's actual draw path (only the scene-graph/schema
 * primitive exists so far), so this test proves "an uploaded asset's ref is
 * usable in a scene by ref" the way Phase 30's own acceptance criteria
 * states it (persisted in the scene document, addressable by
 * `cadra-asset://<hash>`), without depending on unrelated, not-yet-built
 * image-rendering support for the render itself to succeed.
 */

const FPS = 10;
const DURATION_IN_FRAMES = 6;
const WIDTH = 32;
const HEIGHT = 32;

/** Whether real Chromium is available, mirroring `render-job.e2e.test.ts`'s own `isRealChromiumAvailable`. */
function isRealChromiumAvailable(): boolean {
  try {
    const executablePath = chromium.executablePath();
    readFileSync(executablePath);
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = isRealChromiumAvailable();

/** Shape every tool in this suite returns its JSON payload as: one text content block. */
interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content).toBeDefined();
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

interface UploadAssetPayload {
  success: boolean;
  assetRef?: string;
  hash?: string;
  message?: string;
}

interface RenderScenePayload {
  success: boolean;
  jobId?: string;
  message?: string;
}

interface RenderStatusPayload {
  success: boolean;
  outcome?: { ok: true } | { ok: false; message: string };
  jobStatus?: { status: string; totalFrames: number; framesCompleted: number };
  message?: string;
}

interface RenderOutputPayload {
  success: boolean;
  outputPath?: string;
  outputFileName?: string;
  format?: string;
  message?: string;
}

interface GetScenePayload {
  success: boolean;
  document?: SceneDocument;
}

describe("full agent loop: create scene, upload assets, render, poll, fetch output", () => {
  let workspaceRoot: string | undefined;
  let client: Client | undefined;
  let fixtureServer: Server | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = undefined;
    }
    if (fixtureServer !== undefined) {
      await new Promise<void>((resolve) => fixtureServer!.close(() => resolve()));
      fixtureServer = undefined;
    }
  });

  it("renders a tiny composition and produces a real, valid MP4 file whose duration matches the composition", async () => {
    if (!chromiumAvailable) {
      console.log(
        "full agent loop e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-e2e-test-"));
    const outputDirectory = join(workspaceRoot, "out");

    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const connectedClient = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), connectedClient.connect(clientTransport)]);
    client = connectedClient;

    // Step 1: create a scene with one small composition (shape + camera +
    // ambient/directional lights, mirroring render-job.e2e.test.ts's own
    // buildProject) via create_scene.
    const createResult = await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "e2e-scene",
        name: "End-to-end scene",
        composition: {
          id: "comp-1",
          name: "Main",
          fps: FPS,
          durationInFrames: DURATION_IN_FRAMES,
          width: WIDTH,
          height: HEIGHT,
        },
      },
    });
    const createPayload = parseToolResult<{ success: boolean }>(createResult as ToolTextResult);
    expect(createPayload.success).toBe(true);

    // Build out the composition's tracks (shape, camera, ambient light,
    // directional light) via update_scene patch operations, since
    // create_scene only seeds an empty composition with no tracks yet.
    const patchResult = await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "e2e-scene",
        mode: "replace",
        document: buildFullSceneDocument(),
      },
    });
    const patchPayload = parseToolResult<{ success: boolean; diagnostics?: unknown }>(
      patchResult as ToolTextResult,
    );
    expect(patchPayload.success).toBe(true);

    // Step 2a: upload an asset by raw base64 bytes.
    const byBytesBytes = new TextEncoder().encode("e2e fixture asset, uploaded by raw bytes");
    const byBytesResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: {
        bytesBase64: Buffer.from(byBytesBytes).toString("base64"),
        contentType: "image/png",
      },
    });
    const byBytesPayload = parseToolResult<UploadAssetPayload>(byBytesResult as ToolTextResult);
    expect(byBytesPayload.success).toBe(true);
    expect(byBytesPayload.assetRef).toBe(`${ASSET_REF_SCHEME}${hashAssetBytes(byBytesBytes)}`);

    // Step 2b: upload an asset by source URL, served by an in-process test
    // HTTP server (no real internet access needed).
    const byUrlBody = Buffer.from("e2e fixture asset, uploaded by url");
    fixtureServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(byUrlBody);
    });
    await new Promise<void>((resolve) => fixtureServer!.listen(0, "127.0.0.1", () => resolve()));
    const fixtureAddress = fixtureServer.address();
    if (fixtureAddress === null || typeof fixtureAddress === "string") {
      throw new Error("Expected the fixture server to bind to a network address.");
    }
    const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/fixture.png`;

    const byUrlResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { sourceUrl: fixtureUrl },
    });
    const byUrlPayload = parseToolResult<UploadAssetPayload>(byUrlResult as ToolTextResult);
    expect(byUrlPayload.success).toBe(true);
    expect(byUrlPayload.assetRef).toBe(`${ASSET_REF_SCHEME}${hashAssetBytes(new Uint8Array(byUrlBody))}`);

    // Step 3: reference the by-bytes asset's ref from a follow-up
    // update_scene patch: add a new image node (a child of the existing
    // shape node) whose assetRef is exactly the uploaded asset's ref.
    const addNodeResult = await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "e2e-scene",
        mode: "patch",
        operations: [
          {
            type: "addNode",
            parentId: "shape-1",
            node: Image({ id: "image-from-uploaded-asset", assetRef: byBytesPayload.assetRef! }),
          },
        ],
      },
    });
    const addNodePayload = parseToolResult<{ success: boolean }>(addNodeResult as ToolTextResult);
    expect(addNodePayload.success).toBe(true);

    // Confirm the asset ref actually round-trips through get_scene: this is
    // the acceptance criterion "uploaded assets are usable in scenes by
    // ref," proven end to end via the real tool surface, not just unit-level
    // schema validation.
    const getSceneResult = await connectedClient.callTool({
      name: GET_SCENE_TOOL_NAME,
      arguments: { sceneId: "e2e-scene" },
    });
    const getScenePayload = parseToolResult<GetScenePayload>(getSceneResult as ToolTextResult);
    expect(getScenePayload.success).toBe(true);
    const shapeNode = getScenePayload.document?.project.compositions[0]?.tracks
      .find((track) => track.id === "track-shape")
      ?.clips[0]?.node;
    const imageNode = shapeNode?.children.find((child) => child.id === "image-from-uploaded-asset");
    expect(imageNode).toBeDefined();
    expect(imageNode?.kind).toBe("image");
    expect((imageNode as { assetRef?: string } | undefined)?.assetRef).toBe(byBytesPayload.assetRef);

    // Step 4: render the scene via render_scene, which must return
    // immediately with a job id (not block on the whole render finishing).
    const renderResult = await connectedClient.callTool({
      name: RENDER_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "e2e-scene",
        compositionId: "comp-1",
        seed: "e2e-seed",
        format: "mp4",
        bitrate: 1_000_000,
      },
    });
    const renderPayload = parseToolResult<RenderScenePayload>(renderResult as ToolTextResult);
    expect(renderPayload.success).toBe(true);
    const jobId = renderPayload.jobId;
    expect(typeof jobId).toBe("string");

    // Step 5: poll get_render_status until it reports a settled outcome, or
    // this test's own bounded timeout is exceeded (never hangs).
    const pollDeadline = Date.now() + 90_000;
    let finalStatus: RenderStatusPayload | undefined;
    while (Date.now() < pollDeadline) {
      const statusResult = await connectedClient.callTool({
        name: GET_RENDER_STATUS_TOOL_NAME,
        arguments: { jobId },
      });
      const statusPayload = parseToolResult<RenderStatusPayload>(statusResult as ToolTextResult);
      expect(statusPayload.success).toBe(true);

      if (statusPayload.outcome !== undefined) {
        finalStatus = statusPayload;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    expect(finalStatus).toBeDefined();
    expect(finalStatus?.outcome).toEqual({ ok: true });
    expect(finalStatus?.jobStatus?.status).toBe("done");
    expect(finalStatus?.jobStatus?.framesCompleted).toBe(DURATION_IN_FRAMES);

    // Step 6: fetch the finished output's reference via get_render_output,
    // then read the real file it names and validate it is a real, valid
    // MP4 whose container-level duration matches the composition, reusing
    // @cadra/encode's own Phase 21 container validators (matching how
    // Phase 23/25's own e2e tests validated their outputs).
    const outputResult = await connectedClient.callTool({
      name: GET_RENDER_OUTPUT_TOOL_NAME,
      arguments: { jobId },
    });
    const outputPayload = parseToolResult<RenderOutputPayload>(outputResult as ToolTextResult);
    expect(outputPayload.success).toBe(true);
    expect(outputPayload.format).toBe("mp4");
    expect(outputPayload.outputPath).toBeDefined();
    expect(outputPayload.outputPath?.startsWith(outputDirectory)).toBe(true);

    const outputBytes = await readFile(outputPayload.outputPath!);
    expect(outputBytes.byteLength).toBeGreaterThan(512);

    const timescale = readMp4TrackTimescale(outputBytes);
    expect(timescale).toBeGreaterThan(0);
    const durationSeconds = readMp4FragmentedDurationTicks(outputBytes) / timescale;
    expect(durationSeconds).toBeCloseTo(DURATION_IN_FRAMES / FPS, 5);
  }, 120_000);

  it(
    "render_scene's own renderMode/pathTracing override renders path-traced without persisting either onto the scene document (Phase 65)",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "render_scene renderMode override e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-e2e-override-test-"));
      const outputDirectory = join(workspaceRoot, "out");

      const { server } = createCadraMcpServer({
        config: { workspaceRoot, outputDirectory },
        logger: createLogger("test", {}, () => {
          // Swallow log output in tests.
        }),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const connectedClient = new Client({ name: "test-client", version: "0.0.0" });
      await Promise.all([server.connect(serverTransport), connectedClient.connect(clientTransport)]);
      client = connectedClient;

      const createResult = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "e2e-scene",
          name: "End-to-end scene",
          composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: DURATION_IN_FRAMES, width: WIDTH, height: HEIGHT },
        },
      });
      expect(parseToolResult<{ success: boolean }>(createResult as ToolTextResult).success).toBe(true);

      // buildFullSceneDocument()'s composition has no renderMode/pathTracing
      // set at all (defaults to raster) - this render is only path-traced
      // because of render_scene's own override below, never because of
      // anything persisted on the scene document.
      const replaceResult = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "e2e-scene", mode: "replace", document: buildFullSceneDocument() },
      });
      expect(parseToolResult<{ success: boolean }>(replaceResult as ToolTextResult).success).toBe(true);

      const renderResult = await connectedClient.callTool({
        name: RENDER_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "e2e-scene",
          compositionId: "comp-1",
          seed: "e2e-override-seed",
          format: "mp4",
          bitrate: 1_000_000,
          renderMode: "pathTraced",
          pathTracing: { samples: 2, bounces: 1 },
        },
      });
      const renderPayload = parseToolResult<RenderScenePayload>(renderResult as ToolTextResult);
      expect(renderPayload.success).toBe(true);
      const jobId = renderPayload.jobId;

      const pollDeadline = Date.now() + 90_000;
      let finalStatus: RenderStatusPayload | undefined;
      while (Date.now() < pollDeadline) {
        const statusResult = await connectedClient.callTool({
          name: GET_RENDER_STATUS_TOOL_NAME,
          arguments: { jobId },
        });
        const statusPayload = parseToolResult<RenderStatusPayload>(statusResult as ToolTextResult);
        if (statusPayload.outcome !== undefined) {
          finalStatus = statusPayload;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(finalStatus?.outcome).toEqual({ ok: true });

      const outputResult = await connectedClient.callTool({
        name: GET_RENDER_OUTPUT_TOOL_NAME,
        arguments: { jobId },
      });
      const outputPayload = parseToolResult<RenderOutputPayload>(outputResult as ToolTextResult);
      expect(outputPayload.success).toBe(true);
      const outputBytes = await readFile(outputPayload.outputPath!);
      expect(outputBytes.byteLength).toBeGreaterThan(0);
      const timescale = readMp4TrackTimescale(outputBytes);
      expect(timescale).toBeGreaterThan(0);
      expect(readMp4FragmentedDurationTicks(outputBytes) / timescale).toBeCloseTo(DURATION_IN_FRAMES / FPS, 5);

      // The override applied to this one render call only: the persisted
      // scene document itself still has no renderMode/pathTracing set.
      const getSceneResult = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "e2e-scene" },
      });
      const getScenePayload = parseToolResult<GetScenePayload>(getSceneResult as ToolTextResult);
      const persistedComposition = getScenePayload.document?.project.compositions[0];
      expect(persistedComposition?.renderMode).toBeUndefined();
      expect(persistedComposition?.pathTracing).toBeUndefined();
    },
    120_000,
  );
});

/**
 * Builds the full scene document (shape, camera, ambient light, directional
 * light tracks, plus an active camera track) that `create_scene`'s own
 * `composition` option cannot yet seed on its own (it only creates a
 * composition with no tracks). Built from `@cadra/core`'s own node factories
 * (`Shape`/`Camera`/`Light`/`Sequence`/`createComposition`/`createProject`),
 * mirroring `render-job.e2e.test.ts`'s own `buildProject` exactly (same
 * lighting rationale documented there: an ambient plus one directional light
 * so the rendered box is actually visible, not just present), rather than a
 * hand-transcribed raw object, which is much more error-prone against the
 * full node schema (e.g. a camera node's required `target` field is easy to
 * miss by hand). Wrapped in the envelope `update_scene`'s "replace" mode
 * expects.
 */
function buildFullSceneDocument(): SceneDocument {
  const shape = Shape({ id: "shape-1" });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const ambientLight = Light({ id: "light-ambient", lightType: "ambient", intensity: 1.5 });
  const directionalLight = Light({
    id: "light-directional",
    transform: { position: [2, 3, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    lightType: "directional",
    intensity: 1.5,
  });

  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: WIDTH,
    height: HEIGHT,
    tracks: [
      {
        id: "track-shape",
        clips: [
          Sequence({
            id: "clip-shape",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: shape,
          }),
        ],
      },
      {
        id: "track-camera",
        clips: [
          Sequence({
            id: "clip-camera",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: camera,
          }),
        ],
      },
      {
        id: "track-ambient-light",
        clips: [
          Sequence({
            id: "clip-ambient-light",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: ambientLight,
          }),
        ],
      },
      {
        id: "track-directional-light",
        clips: [
          Sequence({
            id: "clip-directional-light",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: directionalLight,
          }),
        ],
      },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [
      { startFrame: 0, durationInFrames: DURATION_IN_FRAMES, cameraNodeId: "camera-1" },
    ],
  };

  const project: Project = createProject({
    id: "e2e-scene",
    name: "End-to-end scene",
    compositions: [withActiveCameraTrack],
  });

  return { schemaVersion: 1, project } as SceneDocument;
}
