import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Camera,
  type Composition,
  createComposition,
  createProject,
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

import { createLogger } from "./logger.js";
import {
  GET_RENDER_OUTPUT_TOOL_NAME,
  GET_RENDER_STATUS_TOOL_NAME,
  PROBE_RENDER_TOOL_NAME,
} from "./render-tools.js";
import { CREATE_SCENE_TOOL_NAME, UPDATE_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

/**
 * Real end-to-end proof that `probe_render` actually renders a smaller,
 * faster draft, not just accepting scaled-down parameters without applying
 * them: submits a real render through the actual MCP tool surface, polls it
 * via the same `get_render_status`/`get_render_output` tools `render_scene`
 * uses, and validates the resulting file is a real, valid, shorter-than-
 * the-full-composition MP4 (`maxDurationInFrames` below is well under the
 * composition's own `DURATION_IN_FRAMES`). Mirrors `render-e2e.test.ts`'s
 * own guard/sizing rationale: small, real Chromium, skips cleanly (never
 * hangs or fails the suite) when no real Chromium is cached in this
 * environment.
 */

const FPS = 10;
const DURATION_IN_FRAMES = 20;
const WIDTH = 64;
const HEIGHT = 48;

function isRealChromiumAvailable(): boolean {
  try {
    readFileSync(chromium.executablePath());
    return true;
  } catch {
    return false;
  }
}

const chromiumAvailable = isRealChromiumAvailable();

interface ToolTextResult {
  content: Array<{ type: string; text: string }>;
}

function parseToolResult<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text) as T;
}

interface ProbeRenderPayload {
  success: boolean;
  jobId?: string;
  width?: number;
  height?: number;
  durationInFrames?: number;
  message?: string;
}

interface RenderStatusPayload {
  success: boolean;
  outcome?: { ok: true } | { ok: false; message: string };
}

interface RenderOutputPayload {
  success: boolean;
  outputPath?: string;
}

function buildLitBoxDocument(sceneId: string): SceneDocument {
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
      { id: "track-shape", clips: [Sequence({ id: "clip-shape", from: 0, durationInFrames: DURATION_IN_FRAMES, content: shape })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: DURATION_IN_FRAMES, content: camera })] },
      { id: "track-ambient", clips: [Sequence({ id: "clip-ambient", from: 0, durationInFrames: DURATION_IN_FRAMES, content: ambientLight })] },
      { id: "track-directional", clips: [Sequence({ id: "clip-directional", from: 0, durationInFrames: DURATION_IN_FRAMES, content: directionalLight })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: DURATION_IN_FRAMES, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({ id: sceneId, name: "Probe render test scene", compositions: [withActiveCameraTrack] });
  return { schemaVersion: 1, project } as SceneDocument;
}

describe("probe_render: real end-to-end draft render", () => {
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
    "renders a scaled-down, frame-capped draft and reports the actual (post-scaling) parameters used",
    async () => {
      if (!chromiumAvailable) {
        console.log("probe_render e2e test: skipping, real Chromium not found (no cached Playwright browser in this environment).");
        return;
      }

      workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-probe-render-e2e-test-"));
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

      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId: "probe-scene",
          name: "Probe scene",
          composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: DURATION_IN_FRAMES, width: WIDTH, height: HEIGHT },
        },
      });
      await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: { sceneId: "probe-scene", mode: "replace", document: buildLitBoxDocument("probe-scene") },
      });

      const maxDurationInFrames = 8;
      const probeResult = await connectedClient.callTool({
        name: PROBE_RENDER_TOOL_NAME,
        arguments: {
          sceneId: "probe-scene",
          compositionId: "comp-1",
          resolutionScale: 0.5,
          maxDurationInFrames,
        },
      });
      const probePayload = parseToolResult<ProbeRenderPayload>(probeResult as ToolTextResult);
      expect(probePayload.success).toBe(true);
      // WIDTH/HEIGHT (64/48) * 0.5 = 32/24, both already even.
      expect(probePayload.width).toBe(32);
      expect(probePayload.height).toBe(24);
      expect(probePayload.durationInFrames).toBe(maxDurationInFrames);

      const jobId = probePayload.jobId;
      const pollDeadline = Date.now() + 60_000;
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
      expect(outputBytes.byteLength).toBeGreaterThan(256);

      const timescale = readMp4TrackTimescale(outputBytes);
      const durationSeconds = readMp4FragmentedDurationTicks(outputBytes) / timescale;
      // The draft's own capped duration (8 frames), not the composition's
      // full 20 - proof maxDurationInFrames actually shortened the render,
      // not just the reported summary.
      expect(durationSeconds).toBeCloseTo(maxDurationInFrames / FPS, 5);
    },
    90_000,
  );
});
