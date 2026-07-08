import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Camera, type Composition, createComposition, createProject, type Project } from "@cadra/core";
import { readMp4FragmentedDurationTicks, readMp4TrackTimescale } from "@cadra/encode";
import type { SceneDocument } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { APPLY_LOOK_PRESET_TOOL_NAME } from "./look-preset-tools.js";
import { GET_RENDER_OUTPUT_TOOL_NAME, GET_RENDER_STATUS_TOOL_NAME, RENDER_SCENE_TOOL_NAME } from "./render-tools.js";
import { CREATE_SCENE_TOOL_NAME, GET_SCENE_TOOL_NAME, UPDATE_SCENE_TOOL_NAME, VALIDATE_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";
import { ADD_TEXT_NODE_TOOL_NAME } from "./text-node-tools.js";

/**
 * Phase 72 task 6: proves an agent can author a cinematic, rich-text scene
 * end to end through MCP - using only this server's own tools, never a
 * hand-authored full `TextNode`/lighting-rig JSON document - and that the
 * result validates and renders.
 *
 * The loop: create_scene (an empty composition with just a camera),
 * add_text_node (a kinetic title: fadeInUp stagger, an outer glow),
 * apply_look_preset (the "cinematic" lighting/post-processing bundle),
 * validate_scene (confirms the assembled document is schema-valid before
 * ever touching the render pipeline), then render_scene/get_render_status/
 * get_render_output, mirroring `render-e2e.test.ts`'s own real-Chromium MP4
 * validation exactly.
 */

const FPS = 10;
const DURATION_IN_FRAMES = 12;
const WIDTH = 64;
const HEIGHT = 64;

/** Whether real Chromium is available, mirroring `render-e2e.test.ts`'s own `isRealChromiumAvailable`. */
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

interface RenderScenePayload {
  success: boolean;
  jobId?: string;
}

interface RenderStatusPayload {
  success: boolean;
  outcome?: { ok: true } | { ok: false; message: string };
  jobStatus?: { status: string; totalFrames: number; framesCompleted: number };
}

interface RenderOutputPayload {
  success: boolean;
  outputPath?: string;
  format?: string;
}

interface GetScenePayload {
  success: boolean;
  document?: SceneDocument;
}

/**
 * A camera-only base scene document (no lights, no shapes): `apply_look_preset`
 * adds the lighting rig, and `add_text_node` adds the (unlit MSDF, per
 * `buildTextGroup`'s own doc) text - nothing else is needed for this scene
 * to render something real. Mirrors `render-e2e.test.ts`'s own
 * `buildFullSceneDocument` structure, just without the shape/light tracks
 * this scene builds through MCP tools instead.
 */
function buildCameraOnlySceneDocument(): SceneDocument {
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
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
        id: "track-camera",
        clips: [{ id: "clip-camera", startFrame: 0, durationInFrames: DURATION_IN_FRAMES, node: camera }],
      },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: DURATION_IN_FRAMES, cameraNodeId: "camera-1" }],
  };

  const project: Project = createProject({
    id: "cinematic-e2e-scene",
    name: "Cinematic End-to-end Scene",
    compositions: [withActiveCameraTrack],
  });

  return { schemaVersion: 1, project } as SceneDocument;
}

describe("full agent loop: author a cinematic, rich-text scene through MCP, validate it, and render it", () => {
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

  it(
    "add_text_node (kinetic stagger + glow) plus apply_look_preset (cinematic) produce a scene that validates and renders a real MP4",
    async () => {
      if (!chromiumAvailable) {
        console.log(
          "cinematic-scene-e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).",
        );
        return;
      }

      workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-cinematic-scene-e2e-test-"));
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

      // Step 1: create the scene (create_scene alone cannot seed tracks, so
      // follow up with an update_scene replace, exactly like render-e2e.test.ts).
      const createResult = await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "cinematic-e2e-scene",
          name: "Cinematic End-to-end Scene",
          composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: DURATION_IN_FRAMES, width: WIDTH, height: HEIGHT },
        },
      });
      expect(parseToolResult<{ success: boolean }>(createResult as ToolTextResult).success).toBe(true);

      const replaceResult = await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "cinematic-e2e-scene", mode: "replace", document: buildCameraOnlySceneDocument() },
      });
      expect(parseToolResult<{ success: boolean }>(replaceResult as ToolTextResult).success).toBe(true);

      // Step 2: add a kinetic, glowing title via add_text_node - the "rich
      // text" half of this task, no hand-written TextNode JSON.
      const textResult = await connectedClient.callTool({
        name: ADD_TEXT_NODE_TOOL_NAME,
        arguments: {
          sceneId: "cinematic-e2e-scene",
          compositionId: "comp-1",
          newTrackId: "track-title",
          clipId: "clip-title",
          textNodeId: "title-text",
          startFrame: 0,
          durationInFrames: DURATION_IN_FRAMES,
          transform: { position: [-1.6, -0.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          content: "CADRA",
          fontSize: 1.2,
          color: [1, 1, 1, 1],
          stagger: {
            preset: "fadeInUp",
            grouping: "character",
            startFrame: 0,
            delayFrames: 1,
            durationFrames: 6,
          },
          glow: { radius: 0.08, color: [0.4, 0.7, 1, 1] },
        },
      });
      const textPayload = parseToolResult<{ success: boolean }>(textResult as ToolTextResult);
      expect(textPayload.success).toBe(true);

      // Step 3: apply the "cinematic" look preset - the lighting/post/grading
      // half of this task, no hand-written light nodes or postProcessing config.
      const lookResult = await connectedClient.callTool({
        name: APPLY_LOOK_PRESET_TOOL_NAME,
        arguments: { sceneId: "cinematic-e2e-scene", compositionId: "comp-1", presetName: "cinematic" },
      });
      const lookPayload = parseToolResult<{ success: boolean }>(lookResult as ToolTextResult);
      expect(lookPayload.success).toBe(true);

      // Step 4: validate_scene confirms the fully-assembled document is
      // schema-valid before this test ever touches the render pipeline -
      // this phase's own explicit "validates" acceptance criterion.
      const getSceneResult = await connectedClient.callTool({
        name: GET_SCENE_TOOL_NAME,
        arguments: { sceneId: "cinematic-e2e-scene" },
      });
      const getScenePayload = parseToolResult<GetScenePayload>(getSceneResult as ToolTextResult);
      expect(getScenePayload.success).toBe(true);

      const validateResult = await connectedClient.callTool({
        name: VALIDATE_SCENE_TOOL_NAME,
        arguments: { document: getScenePayload.document },
      });
      const validatePayload = parseToolResult<{ success: boolean }>(validateResult as ToolTextResult);
      expect(validatePayload.success).toBe(true);

      // Sanity-check the assembled document actually has both halves of
      // this task before rendering: the kinetic text node, and the
      // cinematic preset's own lights/postProcessing.
      const composition = getScenePayload.document!.project.compositions[0]!;
      const titleNode = composition.tracks.find((track) => track.id === "track-title")?.clips[0]?.node;
      expect(titleNode?.kind).toBe("text");
      expect(titleNode?.kind === "text" ? titleNode.stagger?.preset : undefined).toBe("fadeInUp");
      expect(titleNode?.kind === "text" ? titleNode.glow?.radius : undefined).toBe(0.08);
      expect(composition.tracks.filter((track) => track.clips[0]?.node.kind === "light").length).toBeGreaterThan(0);
      expect(composition.postProcessing?.effects.length).toBeGreaterThan(0);

      // Step 5: render, poll, and fetch the finished output, mirroring
      // render-e2e.test.ts's own real-Chromium/real-MP4-container validation.
      const renderResult = await connectedClient.callTool({
        name: RENDER_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "cinematic-e2e-scene",
          compositionId: "comp-1",
          seed: "cinematic-e2e-seed",
          format: "mp4",
          bitrate: 1_000_000,
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

      const outputResult = await connectedClient.callTool({
        name: GET_RENDER_OUTPUT_TOOL_NAME,
        arguments: { jobId },
      });
      const outputPayload = parseToolResult<RenderOutputPayload>(outputResult as ToolTextResult);
      expect(outputPayload.success).toBe(true);
      expect(outputPayload.format).toBe("mp4");

      const outputBytes = await readFile(outputPayload.outputPath!);
      expect(outputBytes.byteLength).toBeGreaterThan(512);

      const timescale = readMp4TrackTimescale(outputBytes);
      expect(timescale).toBeGreaterThan(0);
      const durationSeconds = readMp4FragmentedDurationTicks(outputBytes) / timescale;
      expect(durationSeconds).toBeCloseTo(DURATION_IN_FRAMES / FPS, 5);
    },
    120_000,
  );
});
