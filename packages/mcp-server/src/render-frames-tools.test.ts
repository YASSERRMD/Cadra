import { mkdtemp, rm } from "node:fs/promises";
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
  Text,
} from "@cadra/core";
import { createNativeGpuDevice } from "@cadra/headless";
import type { SceneDocument } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";
import { MAX_FRAMES_PER_RENDER_FRAMES_CALL, RENDER_FRAMES_TOOL_NAME } from "./render-frames-tools.js";
import { CREATE_SCENE_TOOL_NAME, UPDATE_SCENE_TOOL_NAME } from "./scene-tools.js";
import { createCadraMcpServer } from "./server.js";

const FPS = 10;
const DURATION_IN_FRAMES = 6;
const WIDTH = 64;
const HEIGHT = 48;

interface ToolTextResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

interface RenderFramesSummary {
  success: boolean;
  width?: number;
  height?: number;
  frames?: number[];
  message?: string;
}

function parseSummary(result: ToolTextResult): RenderFramesSummary {
  const [content] = result.content;
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text!) as RenderFramesSummary;
}

function imageBlocks(result: ToolTextResult): Array<{ data: string; mimeType: string }> {
  return result.content
    .filter((block) => block.type === "image")
    .map((block) => ({ data: block.data!, mimeType: block.mimeType! }));
}

/** A lit box + camera, matching every other real-render e2e fixture in this package. */
function buildLitBoxDocument(sceneId: string): SceneDocument {
  const shape = Shape({ id: "shape-1", material: { baseColor: [0.8, 0.2, 0.2, 1] } });
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
  const text = Text({
    id: "title",
    content: "Hi.",
    fontSize: 0.6,
    color: [1, 1, 1, 1],
    transform: { position: [-1, -1.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
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
      { id: "track-text", clips: [Sequence({ id: "clip-text", from: 0, durationInFrames: DURATION_IN_FRAMES, content: text })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: DURATION_IN_FRAMES, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({ id: sceneId, name: "Frames test scene", compositions: [withActiveCameraTrack] });
  return { schemaVersion: 1, project } as SceneDocument;
}

describe("render_frames", () => {
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
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-test-"));
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

  it("lists render_frames as a registered tool", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    expect(tools.some((tool) => tool.name === RENDER_FRAMES_TOOL_NAME)).toBe(true);
  });

  it("renders requested frames as real, decodable, non-blank, correctly-sized PNGs, including text", async () => {
    // No cheap synchronous pre-check exists for native WebGPU device
    // availability (acquiring a GPUDevice *is* the check) - mirrors
    // @cadra/headless's own render-frame-native-gpu.e2e.test.ts guard
    // exactly, for the same reason: a sandboxed CI runner with no GPU/
    // software-Vulkan path at all must skip this real-render assertion
    // cleanly rather than fail the whole suite over an environment gap
    // unrelated to render_frames' own correctness.
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames real-render e2e test: skipping, a real native WebGPU device could not be " +
          `acquired on this machine (${String(error)}).`,
      );
      return;
    }

    const connectedClient = await connectClient();
    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-scene",
        name: "Frames scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: DURATION_IN_FRAMES, width: WIDTH, height: HEIGHT },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: { sceneId: "frames-scene", mode: "replace", document: buildLitBoxDocument("frames-scene") },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "frames-scene", compositionId: "comp-1", frames: [0, 3, 5], seed: "frames-test-seed" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(true);
    expect(summary.width).toBe(WIDTH);
    expect(summary.height).toBe(HEIGHT);
    expect(summary.frames).toEqual([0, 3, 5]);

    const images = imageBlocks(result as ToolTextResult);
    expect(images).toHaveLength(3);

    for (const image of images) {
      expect(image.mimeType).toBe("image/png");
      const bytes = Buffer.from(image.data, "base64");
      const png = PNG.sync.read(bytes);
      expect(png.width).toBe(WIDTH);
      expect(png.height).toBe(HEIGHT);

      // Non-blank: at least one pixel must differ from pure transparent
      // black, proving this is a real render (the lit red box, or the
      // white title text), not an empty/failed frame silently encoded.
      let sawNonBlankPixel = false;
      for (let i = 0; i < png.data.length; i += 4) {
        if (png.data[i]! > 0 || png.data[i + 1]! > 0 || png.data[i + 2]! > 0 || png.data[i + 3]! > 0) {
          sawNonBlankPixel = true;
          break;
        }
      }
      expect(sawNonBlankPixel).toBe(true);
    }
  }, 30_000);

  it("rejects a request for more than the maximum frames per call, at the input-schema level", async () => {
    const connectedClient = await connectClient();
    const tooMany = Array.from({ length: MAX_FRAMES_PER_RENDER_FRAMES_CALL + 1 }, (_, i) => i);

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "does-not-matter", compositionId: "comp-1", frames: tooMany, seed: "s" },
    });

    expect(result.isError).toBe(true);
  });

  it("returns an actionable diagnostic for a frame outside the composition's own duration, without throwing", async () => {
    const connectedClient = await connectClient();
    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-scene-oob",
        name: "Frames scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: DURATION_IN_FRAMES, width: WIDTH, height: HEIGHT },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: { sceneId: "frames-scene-oob", mode: "replace", document: buildLitBoxDocument("frames-scene-oob") },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: {
        sceneId: "frames-scene-oob",
        compositionId: "comp-1",
        frames: [0, DURATION_IN_FRAMES + 10],
        seed: "s",
      },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(false);
    expect(summary.message).toContain(String(DURATION_IN_FRAMES + 10));
    expect(imageBlocks(result as ToolTextResult)).toHaveLength(0);
  });

  it("returns an actionable diagnostic for an unknown scene id, without throwing", async () => {
    const connectedClient = await connectClient();
    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "no-such-scene", compositionId: "comp-1", frames: [0], seed: "s" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(false);
    expect(summary.message).toContain("no-such-scene");
  });
});
