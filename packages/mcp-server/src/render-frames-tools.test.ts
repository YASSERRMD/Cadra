import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Camera,
  type Composition,
  createComposition,
  createProject,
  Image,
  Light,
  Model,
  type Project,
  Satori,
  Sequence,
  Shape,
  Text,
  Video,
} from "@cadra/core";
import { createNativeGpuDevice } from "@cadra/headless";
import type { SceneDocument } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PNG } from "pngjs";
import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UPLOAD_ASSET_TOOL_NAME } from "./asset-tools.js";
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
  return parseJson<RenderFramesSummary>(result);
}

/** Parses any tool's own leading JSON text content block, generically - `parseSummary`'s own shape is specific to `render_frames`; other tools (e.g. `upload_asset`) need their own result type. */
function parseJson<T>(result: ToolTextResult): T {
  const [content] = result.content;
  expect(content?.type).toBe("text");
  return JSON.parse(content!.text!) as T;
}

interface UploadAssetSummary {
  success: boolean;
  assetRef?: string;
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

/** A solid-color square PNG, real and valid, mirroring `render-e2e.test.ts`'s own `buildSolidColorPng`. */
function buildSolidColorPng(size: number, color: readonly [number, number, number]): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let i = 0; i < size * size; i += 1) {
    const index = i << 2;
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
}

/** A square PNG, solid pure red across its own top half and solid pure blue across its own bottom half, mirroring `@cadra/encode`'s own `browser-headless-render-entry.e2e.test.ts` `buildTwoToneTestPng` - deliberately asymmetric top-vs-bottom so a vertical mirror (a flipY-class bug) is empirically distinguishable from correct orientation. */
function buildTwoToneTestPng(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (size * y + x) << 2;
      const isTopHalf = y < size / 2;
      png.data[index] = isTopHalf ? 255 : 0;
      png.data[index + 1] = 0;
      png.data[index + 2] = isTopHalf ? 0 : 255;
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A minimal scene document with one `ImageNode` (scaled to fill the whole frame - see the size/camera-distance math this mirrors from `@cadra/encode`'s own `browser-headless-render-entry.e2e.test.ts`) and a `CameraNode`, no lights (an `ImageNode`'s `MeshBasicMaterial` is unlit). */
function buildImageFillsFrameDocument(sceneId: string, compositionId: string, size: number, assetRef: string): SceneDocument {
  const image = Image({
    id: "image-1",
    assetRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [8, 8, 8] },
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const composition = createComposition({
    id: compositionId,
    name: "Main",
    fps: FPS,
    durationInFrames: 1,
    width: size,
    height: size,
    tracks: [
      { id: "track-image", clips: [Sequence({ id: "clip-image", from: 0, durationInFrames: 1, content: image })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({ id: sceneId, name: "Frames image scene", compositions: [withActiveCameraTrack] });
  return { schemaVersion: 1, project } as SceneDocument;
}

/** Reads one RGBA pixel out of a decoded PNG's own flat, top-left-origin RGBA8 buffer. */
function pixelAt(data: Buffer, width: number, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const index = (y * width + x) * 4;
  return { r: data[index]!, g: data[index + 1]!, b: data[index + 2]!, a: data[index + 3]! };
}

/**
 * Proves `render_frames`' own native-GPU-headless path (unlike `render_scene`/
 * `probe_render`'s browser path) actually delivers real, uploaded image
 * asset bytes - pixel-verified, including orientation, matching the exact
 * rigor `@cadra/encode`'s own `browser-headless-render-entry.e2e.test.ts`
 * already applies to the browser path. Simpler here than that suite: this
 * tool already returns real, decodable PNG bytes directly in its own tool
 * result (no video encode/mux/WebCodecs-decode round trip needed at all to
 * get real pixels back).
 */
describe("render_frames: real ImageNode texture rendering", () => {
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

  it("renders a real, uploaded image's own real pixel content, right-side up (not vertically mirrored, not the gray placeholder)", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames ImageNode texture e2e test: skipping, a real native WebGPU device could not " +
          `be acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-image-test-"));
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

    const pngBytes = buildTwoToneTestPng(32);
    const uploadResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: pngBytes.toString("base64"), contentType: "image/png" },
    });
    const uploadPayload = parseJson<UploadAssetSummary>(uploadResult as ToolTextResult);
    expect(uploadPayload.success).toBe(true);
    const assetRef = uploadPayload.assetRef!;

    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-image-scene",
        name: "Frames image scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 32, height: 32 },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-image-scene",
        mode: "replace",
        document: buildImageFillsFrameDocument("frames-image-scene", "comp-1", 32, assetRef),
      },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "frames-image-scene", compositionId: "comp-1", frames: [0], seed: "frames-image-seed" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(true);

    const images = imageBlocks(result as ToolTextResult);
    expect(images).toHaveLength(1);
    const png = PNG.sync.read(Buffer.from(images[0]!.data, "base64"));

    // Sampled a few pixels in from the vertical center, clear of any
    // decode/render antialiasing bleed at the red/blue boundary row.
    const topPixel = pixelAt(png.data, png.width, 16, 4);
    const bottomPixel = pixelAt(png.data, png.width, 16, 28);

    // Top of frame: the source PNG's own top half was pure red. A
    // flipY-class bug would show blue here instead (the source's own
    // bottom half, mirrored to the top) - the gray placeholder (0x808080)
    // would show neither channel dominant.
    expect(topPixel.r).toBeGreaterThan(150);
    expect(topPixel.b).toBeLessThan(100);

    // Bottom of frame: the source PNG's own bottom half was pure blue.
    expect(bottomPixel.b).toBeGreaterThan(150);
    expect(bottomPixel.r).toBeLessThan(100);
  }, 30_000);

  it("renders visibly different output for two scenes whose only difference is which uploaded image asset their ImageNode references", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames ImageNode asset-bytes e2e test: skipping, a real native WebGPU device could " +
          `not be acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-image-diff-test-"));
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

    const redPng = buildSolidColorPng(8, [255, 0, 0]);
    const bluePng = buildSolidColorPng(8, [0, 0, 255]);

    const uploadRed = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: redPng.toString("base64"), contentType: "image/png" },
    });
    const redAssetRef = parseJson<UploadAssetSummary>(uploadRed as ToolTextResult).assetRef!;

    const uploadBlue = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: bluePng.toString("base64"), contentType: "image/png" },
    });
    const blueAssetRef = parseJson<UploadAssetSummary>(uploadBlue as ToolTextResult).assetRef!;

    async function renderWithImage(sceneId: string, assetRef: string): Promise<Buffer> {
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          name: "Frames image scene",
          composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 16, height: 16 },
        },
      });
      await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          mode: "replace",
          document: buildImageFillsFrameDocument(sceneId, "comp-1", 16, assetRef),
        },
      });
      const result = await connectedClient.callTool({
        name: RENDER_FRAMES_TOOL_NAME,
        arguments: { sceneId, compositionId: "comp-1", frames: [0], seed: "fixed-seed" },
      });
      const images = imageBlocks(result as ToolTextResult);
      expect(images).toHaveLength(1);
      return Buffer.from(images[0]!.data, "base64");
    }

    const redOutput = await renderWithImage("frames-red-image", redAssetRef);
    const blueOutput = await renderWithImage("frames-blue-image", blueAssetRef);

    expect(Buffer.compare(redOutput, blueOutput)).not.toBe(0);
  }, 30_000);
});

/** Whether a real `ffmpeg` binary is on `PATH` - checked once per test, mirroring `render_frames`' own native-GPU-device-acquisition skip-guard, since real Node-side video decoding needs both a real device *and* a real `ffmpeg`. */
function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

/** A real, real-encoded MP4 - solid pure red across its own top half, solid pure blue across its own bottom half (via ffmpeg's own `vstack` filter combining two solid-color `lavfi` sources) - the video-asset counterpart to `buildTwoToneTestPng`, deliberately asymmetric top-vs-bottom for the exact same reason. */
function buildTwoToneTestVideo(size: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        `color=red:size=${size}x${size / 2}:duration=1:rate=4`,
        "-f",
        "lavfi",
        "-i",
        `color=blue:size=${size}x${size / 2}:duration=1:rate=4`,
        "-filter_complex",
        "[0:v][1:v]vstack=inputs=2",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code} while encoding the two-tone test video fixture`));
        return;
      }
      resolvePromise(Buffer.concat(chunks));
    });
  });
}

/** A minimal scene document with one `VideoNode` (scaled to fill the whole frame, mirroring `buildImageFillsFrameDocument`'s own size/camera-distance math - a video node's own geometry is the same unit-plane-sized-to-aspect convention an image node's is) and a `CameraNode`, no lights (a `VideoNode`'s `MeshBasicMaterial` is unlit). */
function buildVideoFillsFrameDocument(sceneId: string, compositionId: string, size: number, assetRef: string): SceneDocument {
  const video = Video({
    id: "video-1",
    assetRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [8, 8, 8] },
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const composition = createComposition({
    id: compositionId,
    name: "Main",
    fps: FPS,
    durationInFrames: 1,
    width: size,
    height: size,
    tracks: [
      { id: "track-video", clips: [Sequence({ id: "clip-video", from: 0, durationInFrames: 1, content: video })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({ id: sceneId, name: "Frames video scene", compositions: [withActiveCameraTrack] });
  return { schemaVersion: 1, project } as SceneDocument;
}

/**
 * Proves `render_frames`' own native-GPU-headless path actually delivers
 * real, uploaded video asset frames - pixel-verified, including
 * orientation - via a real `ffmpeg` child process
 * (`@cadra/encode`'s own `decodeVideoFramesWithFfmpeg`), the one asset kind
 * with no pure-JS decode path the way `pngjs` covers images: this tool
 * silently rendered every `VideoNode` as the documented gray placeholder
 * before this wiring existed. Mirrors "real ImageNode texture rendering"'s
 * own rigor exactly, with an added skip guard: this needs a real `ffmpeg`
 * on `PATH`, not just a real native GPU device.
 */
describe("render_frames: real VideoNode texture rendering", () => {
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

  it("renders a real, uploaded video asset's own real decoded frame content, right-side up (not vertically mirrored, not the gray placeholder)", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames VideoNode texture e2e test: skipping, a real native WebGPU device could not " +
          `be acquired on this machine (${String(error)}).`,
      );
      return;
    }
    if (!(await ffmpegAvailable())) {
      console.log(
        "render_frames VideoNode texture e2e test: skipping, a real ffmpeg binary is not available on this machine's PATH.",
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-video-test-"));
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

    const videoBytes = await buildTwoToneTestVideo(32);
    const uploadResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: videoBytes.toString("base64"), contentType: "video/mp4" },
    });
    const uploadPayload = parseJson<UploadAssetSummary>(uploadResult as ToolTextResult);
    expect(uploadPayload.success).toBe(true);
    const assetRef = uploadPayload.assetRef!;

    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-video-scene",
        name: "Frames video scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 32, height: 32 },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-video-scene",
        mode: "replace",
        document: buildVideoFillsFrameDocument("frames-video-scene", "comp-1", 32, assetRef),
      },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "frames-video-scene", compositionId: "comp-1", frames: [0], seed: "frames-video-seed" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(true);

    const images = imageBlocks(result as ToolTextResult);
    expect(images).toHaveLength(1);
    const png = PNG.sync.read(Buffer.from(images[0]!.data, "base64"));

    // Sampled a few pixels in from the vertical center, clear of any
    // decode/render antialiasing bleed at the red/blue boundary row.
    const topPixel = pixelAt(png.data, png.width, 16, 4);
    const bottomPixel = pixelAt(png.data, png.width, 16, 28);

    // Top of frame: the source video's own top half was pure red. A
    // flipY-class bug would show blue here instead (the source's own
    // bottom half, mirrored to the top) - the gray placeholder (0x404040)
    // would show neither channel dominant.
    expect(topPixel.r).toBeGreaterThan(150);
    expect(topPixel.b).toBeLessThan(100);

    // Bottom of frame: the source video's own bottom half was pure blue.
    expect(bottomPixel.b).toBeGreaterThan(150);
    expect(bottomPixel.r).toBeLessThan(100);
  }, 30_000);
});

/**
 * A minimal scene document with one `SatoriNode` whose own `layer` is a
 * single solid-color `div` (no text at all, so no font-family-matching
 * question to worry about - see `buildSatoriLayerRenderRegistryForProject`'s
 * own doc) and a `CameraNode`, no lights (a satori layer's own rasterized
 * texture, applied via `MeshBasicMaterial`, is unlit). Unlike
 * `buildImageFillsFrameDocument`, a satori node's own geometry is sized
 * directly from its own `width`/`height` in world units (not normalized to
 * 1 unit wide - see `node-factory.ts`'s own satori mesh construction), so a
 * generously large, fixed `width`/`height` (independent of the
 * composition's own pixel size) trivially guarantees it fills the whole
 * camera frustum with no background pixel anywhere to accidentally sample,
 * with no camera-distance math needed at all.
 */
function buildSatoriFillsFrameDocument(
  sceneId: string,
  compositionId: string,
  compositionSize: number,
  layerColor: string,
): SceneDocument {
  const satori = Satori({
    id: "satori-1",
    layer: {
      type: "div",
      style: { width: "100%", height: "100%", backgroundColor: layerColor, display: "flex" },
    },
    width: 400,
    height: 400,
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const composition = createComposition({
    id: compositionId,
    name: "Main",
    fps: FPS,
    durationInFrames: 1,
    width: compositionSize,
    height: compositionSize,
    tracks: [
      { id: "track-satori", clips: [Sequence({ id: "clip-satori", from: 0, durationInFrames: 1, content: satori })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({ id: sceneId, name: "Frames satori scene", compositions: [withActiveCameraTrack] });
  return { schemaVersion: 1, project } as SceneDocument;
}

/** A `SatoriNode` layer containing real text (white on black, filling the frame) plus a `CameraNode` - proves real glyphs render, not just a solid-color layer (`buildSatoriFillsFrameDocument`'s own coverage). */
function buildSatoriTextFillsFrameDocument(sceneId: string, compositionId: string, compositionSize: number): SceneDocument {
  const satori = Satori({
    id: "satori-1",
    layer: {
      type: "div",
      style: {
        width: "100%",
        height: "100%",
        backgroundColor: "#000000",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      },
      children: [
        {
          type: "span",
          style: { color: "#ffffff", fontSize: 28 },
          children: ["Hi"],
        },
      ],
    },
    width: 400,
    height: 400,
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const composition = createComposition({
    id: compositionId,
    name: "Main",
    fps: FPS,
    durationInFrames: 1,
    width: compositionSize,
    height: compositionSize,
    tracks: [
      { id: "track-satori", clips: [Sequence({ id: "clip-satori", from: 0, durationInFrames: 1, content: satori })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({
    id: sceneId,
    name: "Frames satori text scene",
    compositions: [withActiveCameraTrack],
  });
  return { schemaVersion: 1, project } as SceneDocument;
}

/**
 * Proves `render_frames`' own native-GPU-headless path actually renders a
 * real `SatoriNode`, not the documented empty-group placeholder every
 * `"satori"` node silently fell back to before `buildSatoriLayerRenderRegistryForProject`
 * existed (the `SatoriLayerRenderRegistry`/`prepareSatoriLayerRenderData`
 * pipeline was fully built and independently tested - including
 * `@cadra/svg-raster`'s own real Satori-render-then-resvg-rasterize
 * end-to-end test - but had zero real callers anywhere in this codebase
 * until this wiring).
 */
describe("render_frames: real SatoriNode rendering", () => {
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

  it("renders a real SatoriNode's own rasterized pixels (a solid-color layer), not the empty placeholder", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames SatoriNode e2e test: skipping, a real native WebGPU device could not be " +
          `acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-satori-test-"));
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

    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-satori-scene",
        name: "Frames satori scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 32, height: 32 },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-satori-scene",
        mode: "replace",
        document: buildSatoriFillsFrameDocument("frames-satori-scene", "comp-1", 32, "#ff0000"),
      },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "frames-satori-scene", compositionId: "comp-1", frames: [0], seed: "frames-satori-seed" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(true);

    const images = imageBlocks(result as ToolTextResult);
    expect(images).toHaveLength(1);
    const png = PNG.sync.read(Buffer.from(images[0]!.data, "base64"));

    const centerPixel = pixelAt(png.data, png.width, 16, 16);
    // Real, rasterized red - not the placeholder (an empty group renders
    // nothing at all, leaving this pixel transparent black instead).
    expect(centerPixel.r).toBeGreaterThan(200);
    expect(centerPixel.g).toBeLessThan(50);
    expect(centerPixel.b).toBeLessThan(50);
    expect(centerPixel.a).toBeGreaterThan(200);
  }, 30_000);

  it("renders visibly different output for two scenes whose only difference is their SatoriNode's own layer color", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames SatoriNode color-diff e2e test: skipping, a real native WebGPU device could " +
          `not be acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-satori-diff-test-"));
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

    async function renderWithColor(sceneId: string, color: string): Promise<Buffer> {
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          name: "Frames satori scene",
          composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 16, height: 16 },
        },
      });
      await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          mode: "replace",
          document: buildSatoriFillsFrameDocument(sceneId, "comp-1", 16, color),
        },
      });
      const result = await connectedClient.callTool({
        name: RENDER_FRAMES_TOOL_NAME,
        arguments: { sceneId, compositionId: "comp-1", frames: [0], seed: "fixed-seed" },
      });
      const images = imageBlocks(result as ToolTextResult);
      expect(images).toHaveLength(1);
      return Buffer.from(images[0]!.data, "base64");
    }

    const redOutput = await renderWithColor("frames-satori-red", "#ff0000");
    const blueOutput = await renderWithColor("frames-satori-blue", "#0000ff");

    expect(Buffer.compare(redOutput, blueOutput)).not.toBe(0);
  }, 30_000);

  it("renders a SatoriNode layer's own text as real glyphs, not blank space", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames SatoriNode text e2e test: skipping, a real native WebGPU device could not be " +
          `acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-satori-text-test-"));
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

    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-satori-text-scene",
        name: "Frames satori text scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 64, height: 64 },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-satori-text-scene",
        mode: "replace",
        document: buildSatoriTextFillsFrameDocument("frames-satori-text-scene", "comp-1", 64),
      },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "frames-satori-text-scene", compositionId: "comp-1", frames: [0], seed: "frames-satori-text-seed" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(true);

    const images = imageBlocks(result as ToolTextResult);
    expect(images).toHaveLength(1);
    const png = PNG.sync.read(Buffer.from(images[0]!.data, "base64"));

    // Solid black background, solid white text: real glyphs mean a
    // meaningful fraction of pixels are white; the pre-fix behavior (an
    // empty fonts array, no glyphs drawn at all) would leave every pixel
    // solid black instead.
    let whitePixelCount = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i]! > 200 && png.data[i + 1]! > 200 && png.data[i + 2]! > 200) {
        whitePixelCount += 1;
      }
    }
    expect(whitePixelCount).toBeGreaterThan(20);
  }, 30_000);
});

/**
 * A minimal `FileReader` standing in for the real DOM one, mirroring
 * `@cadra/renderer`'s own `gltf-loader.test.ts` `NodeFileReaderPolyfill`
 * exactly: `GLTFExporter`'s own writer unconditionally reaches for a real
 * `FileReader` to turn its own merged `Blob` into an `ArrayBuffer` (binary
 * `.glb` mode), a genuine DOM API this headless Vitest/Node environment does
 * not provide on its own.
 */
class NodeFileReaderPolyfill {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer;
      this.onloadend?.();
    });
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      const base64 = Buffer.from(buffer).toString("base64");
      this.result = `data:${blob.type};base64,${base64}`;
      this.onloadend?.();
    });
  }
}

/**
 * Builds a real, self-contained `.glb`'s raw bytes: a unit `THREE.BoxGeometry`
 * with a solid-`color` `MeshStandardMaterial`, round-tripped through
 * `GLTFExporter`'s own `binary: true` mode - the exact same real-GLB
 * construction `@cadra/renderer`'s own `gltf-loader.test.ts` already proves
 * `createDefaultParseGltf` (the parser `buildModelRegistryForProject` uses)
 * correctly parses back into a usable mesh, reused here to prove the whole
 * upload-asset-through-render_frames pipeline end to end instead of only the
 * parse step in isolation.
 */
async function buildGlbBytes(color: number): Promise<Uint8Array> {
  vi.stubGlobal("FileReader", NodeFileReaderPolyfill);
  try {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "TestBox";
    const scene = new THREE.Scene();
    scene.add(mesh);

    const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    return new Uint8Array(glb);
  } finally {
    vi.unstubAllGlobals();
  }
}

/**
 * A minimal scene document with one `ModelNode` (scaled to `[4, 4, 4]` - a
 * unit box's near face then sits at world Z `+2`, well inside the default
 * `fov: 50`/distance-5 camera's frustum at that depth, filling the whole
 * frame with no background pixel anywhere left to accidentally sample -
 * mirroring `buildImageFillsFrameDocument`'s own "generously overfill, no
 * per-test camera-distance math" approach), a `CameraNode`, and ambient +
 * directional lighting (a `ModelNode`'s cloned material is whatever the
 * source GLTF authored - here, a lit `MeshStandardMaterial` - unlike
 * `ImageNode`/`SatoriNode`'s always-unlit `MeshBasicMaterial`, so this needs
 * real light to be visible at all, mirroring this file's own
 * `buildLitBoxDocument`).
 */
function buildModelFillsFrameDocument(sceneId: string, compositionId: string, size: number, assetRef: string): SceneDocument {
  const model = Model({
    id: "model-1",
    assetRef,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [4, 4, 4] },
  });
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
    id: compositionId,
    name: "Main",
    fps: FPS,
    durationInFrames: 1,
    width: size,
    height: size,
    tracks: [
      { id: "track-model", clips: [Sequence({ id: "clip-model", from: 0, durationInFrames: 1, content: model })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })] },
      { id: "track-ambient", clips: [Sequence({ id: "clip-ambient", from: 0, durationInFrames: 1, content: ambientLight })] },
      { id: "track-directional", clips: [Sequence({ id: "clip-directional", from: 0, durationInFrames: 1, content: directionalLight })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({ id: sceneId, name: "Frames model scene", compositions: [withActiveCameraTrack] });
  return { schemaVersion: 1, project } as SceneDocument;
}

/**
 * Proves `render_frames`' own native-GPU-headless path actually renders a
 * real `ModelNode`, not the documented empty-group placeholder every
 * `"model"` node silently fell back to before `buildModelRegistryForProject`
 * existed (the reconciler's own `buildModelObject`/`applyModelProperties`,
 * and the GLTF loader/registry beneath them, were fully built and
 * independently tested - but had zero real callers anywhere in this
 * codebase until this wiring).
 */
describe("render_frames: real ModelNode rendering", () => {
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

  it("renders a real ModelNode's own uploaded GLB mesh (a solid-color box), not the empty placeholder", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames ModelNode e2e test: skipping, a real native WebGPU device could not be " +
          `acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-model-test-"));
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

    const glbBytes = await buildGlbBytes(0xff0000);
    const uploadResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: Buffer.from(glbBytes).toString("base64"), contentType: "model/gltf-binary" },
    });
    const uploadPayload = parseJson<UploadAssetSummary>(uploadResult as ToolTextResult);
    expect(uploadPayload.success).toBe(true);
    const assetRef = uploadPayload.assetRef!;

    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-model-scene",
        name: "Frames model scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 32, height: 32 },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-model-scene",
        mode: "replace",
        document: buildModelFillsFrameDocument("frames-model-scene", "comp-1", 32, assetRef),
      },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "frames-model-scene", compositionId: "comp-1", frames: [0], seed: "frames-model-seed" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(true);

    const images = imageBlocks(result as ToolTextResult);
    expect(images).toHaveLength(1);
    const png = PNG.sync.read(Buffer.from(images[0]!.data, "base64"));

    const centerPixel = pixelAt(png.data, png.width, 16, 16);
    // Real, lit red box - not the placeholder (an empty group renders
    // nothing at all, leaving this pixel transparent black instead).
    expect(centerPixel.r).toBeGreaterThan(100);
    expect(centerPixel.g).toBeLessThan(80);
    expect(centerPixel.b).toBeLessThan(80);
    expect(centerPixel.a).toBeGreaterThan(200);
  }, 30_000);

  it("renders visibly different output for two scenes whose only difference is their ModelNode's own GLB material color", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames ModelNode color-diff e2e test: skipping, a real native WebGPU device could " +
          `not be acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-model-diff-test-"));
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

    const redGlbBytes = await buildGlbBytes(0xff0000);
    const blueGlbBytes = await buildGlbBytes(0x0000ff);

    const uploadRed = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: Buffer.from(redGlbBytes).toString("base64"), contentType: "model/gltf-binary" },
    });
    const redAssetRef = parseJson<UploadAssetSummary>(uploadRed as ToolTextResult).assetRef!;

    const uploadBlue = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: Buffer.from(blueGlbBytes).toString("base64"), contentType: "model/gltf-binary" },
    });
    const blueAssetRef = parseJson<UploadAssetSummary>(uploadBlue as ToolTextResult).assetRef!;

    async function renderWithModel(sceneId: string, assetRef: string): Promise<Buffer> {
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          name: "Frames model scene",
          composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 16, height: 16 },
        },
      });
      await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          mode: "replace",
          document: buildModelFillsFrameDocument(sceneId, "comp-1", 16, assetRef),
        },
      });
      const result = await connectedClient.callTool({
        name: RENDER_FRAMES_TOOL_NAME,
        arguments: { sceneId, compositionId: "comp-1", frames: [0], seed: "fixed-seed" },
      });
      const images = imageBlocks(result as ToolTextResult);
      expect(images).toHaveLength(1);
      return Buffer.from(images[0]!.data, "base64");
    }

    const redOutput = await renderWithModel("frames-red-model", redAssetRef);
    const blueOutput = await renderWithModel("frames-blue-model", blueAssetRef);

    expect(Buffer.compare(redOutput, blueOutput)).not.toBe(0);
  }, 30_000);
});

/**
 * Encodes one new-RLE-format Radiance scanline whose entire width is a
 * single solid RGBE color: a 4-byte marker (`[2, 2, hi(width), lo(width)]`,
 * the documented "new RLE" signature `HDRLoader` requires for any scanline
 * width `>= 8`) followed by one run-length chunk per channel (R, G, B, E),
 * each `[128 + width, value]` - a byte `> 128` means "repeat the next byte
 * `(byte - 128)` times", the documented encoding for a run. `width` must fit
 * in that single run-count byte (`<= 127`).
 */
function encodeUniformHdrRow(width: number, r: number, g: number, b: number, e: number): Buffer {
  if (width > 127) {
    throw new Error("encodeUniformHdrRow: run length must fit in one byte (<=127)");
  }
  return Buffer.from([
    2, 2, (width >> 8) & 0xff, width & 0xff,
    128 + width, r,
    128 + width, g,
    128 + width, b,
    128 + width, e,
  ]);
}

/**
 * A real, hand-built, new-RLE-encoded Radiance HDR (`.hdr`) file: 64
 * wide (`@cadra/renderer`'s own `PMREMGenerator`-driven prefiltering
 * requires at least 64x32 - see `ENVIRONMENT_TEXTURE_WIDTH`/`_HEIGHT` in
 * that package's own `environment-registry.ts` - a smaller fixture
 * empirically produces a fully black prefiltered result instead, verified
 * directly against this exact test), top half solid red and bottom half
 * solid green, so a metal sphere reflecting it picks up real, non-neutral
 * color unmistakably different from the built-in "studio" rig's own
 * neutral grey tones.
 */
function buildStripedHdrBytes(): Buffer {
  const width = 64;
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 32 +X ${width}\n`, "utf8");
  const rows: Buffer[] = [];
  for (let i = 0; i < 16; i += 1) {
    rows.push(encodeUniformHdrRow(width, 128, 0, 0, 128)); // R=0.5
  }
  for (let i = 0; i < 16; i += 1) {
    rows.push(encodeUniformHdrRow(width, 0, 128, 0, 128)); // G=0.5
  }
  return Buffer.concat([header, ...rows]);
}

/** A minimal, real, hand-written `.cube` file that maps every input color to solid pure green, regardless of input - deliberately extreme (not a subtle grade) so its effect on any rendered content is unambiguous. */
function buildSolidGreenCubeText(): Buffer {
  const line = "0.0 1.0 0.0";
  return Buffer.from(["TITLE \"Solid Green\"", "LUT_3D_SIZE 2", line, line, line, line, line, line, line, line, ""].join("\n"), "utf8");
}

/** A near-mirror metal sphere plus a camera, no explicit lights - deliberately relying purely on `environment`'s own IBL contribution, so whatever `envMapRef` resolves to is the dominant (only) thing visible in the render. */
function buildReflectiveSphereDocument(
  sceneId: string,
  compositionId: string,
  size: number,
  envMapRef: string,
): SceneDocument {
  const sphere = Shape({
    id: "sphere-1",
    geometryRef: "sphere",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [2.2, 2.2, 2.2] },
    material: { baseColor: [1, 1, 1, 1], metalness: 1, roughness: 0.05 },
  });
  const camera = Camera({
    id: "camera-1",
    transform: { position: [0, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const composition = createComposition({
    id: compositionId,
    name: "Main",
    fps: FPS,
    durationInFrames: 1,
    width: size,
    height: size,
    environment: { envMapRef, intensity: 1.5 },
    tracks: [
      { id: "track-sphere", clips: [Sequence({ id: "clip-sphere", from: 0, durationInFrames: 1, content: sphere })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })] },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({
    id: sceneId,
    name: "Frames environment scene",
    compositions: [withActiveCameraTrack],
  });
  return { schemaVersion: 1, project } as SceneDocument;
}

/** A plain lit box, camera, and a `lut` post-processing effect - any rendered content works for a LUT test (it grades the whole final image), so this deliberately reuses no other asset kind. */
function buildLutGradedBoxDocument(
  sceneId: string,
  compositionId: string,
  size: number,
  lutRef: string,
): SceneDocument {
  const box = Shape({
    id: "box-1",
    material: { baseColor: [0.6, 0.6, 0.6, 1], metalness: 0, roughness: 0.8 },
    transform: { position: [0, 0, 0], rotation: [0.3, 0.4, 0], scale: [2, 2, 2] },
  });
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
    id: compositionId,
    name: "Main",
    fps: FPS,
    durationInFrames: 1,
    width: size,
    height: size,
    postProcessing: { effects: [{ type: "lut", lutRef, intensity: 1 }] },
    tracks: [
      { id: "track-box", clips: [Sequence({ id: "clip-box", from: 0, durationInFrames: 1, content: box })] },
      { id: "track-camera", clips: [Sequence({ id: "clip-camera", from: 0, durationInFrames: 1, content: camera })] },
      {
        id: "track-ambient",
        clips: [Sequence({ id: "clip-ambient", from: 0, durationInFrames: 1, content: ambientLight })],
      },
      {
        id: "track-directional",
        clips: [Sequence({ id: "clip-directional", from: 0, durationInFrames: 1, content: directionalLight })],
      },
    ],
  });
  const withActiveCameraTrack: Composition = {
    ...composition,
    activeCameraTrack: [{ startFrame: 0, durationInFrames: 1, cameraNodeId: "camera-1" }],
  };
  const project: Project = createProject({ id: sceneId, name: "Frames LUT scene", compositions: [withActiveCameraTrack] });
  return { schemaVersion: 1, project } as SceneDocument;
}

/**
 * Proves `render_frames`' own native-GPU-headless path actually resolves a
 * real uploaded HDR environment through `Composition.environment.envMapRef`
 * - beyond the renderer's own built-in `"studio"`/`"outdoor"` procedural
 * refs, which is all this path previously ever reached (see
 * `buildEnvironmentRegistryForProject`'s own doc in `@cadra/encode`).
 */
describe("render_frames: real environment map (envMapRef) rendering", () => {
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

  it("renders visibly different output for a real uploaded HDR envMapRef than for the built-in 'studio' default", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames environment e2e test: skipping, a real native WebGPU device could not be " +
          `acquired on this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-environment-test-"));
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

    const uploadResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: buildStripedHdrBytes().toString("base64"), contentType: "application/octet-stream" },
    });
    const uploadPayload = parseJson<UploadAssetSummary>(uploadResult as ToolTextResult);
    expect(uploadPayload.success).toBe(true);
    const envAssetRef = uploadPayload.assetRef!;

    async function renderWithEnvMapRef(sceneId: string, envMapRef: string): Promise<Buffer> {
      await connectedClient.callTool({
        name: CREATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          name: "Frames environment scene",
          composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 32, height: 32 },
        },
      });
      await connectedClient.callTool({
        name: UPDATE_SCENE_TOOL_NAME,
        arguments: {
          sceneId,
          mode: "replace",
          document: buildReflectiveSphereDocument(sceneId, "comp-1", 32, envMapRef),
        },
      });
      const result = await connectedClient.callTool({
        name: RENDER_FRAMES_TOOL_NAME,
        arguments: { sceneId, compositionId: "comp-1", frames: [0], seed: "fixed-seed" },
      });
      const images = imageBlocks(result as ToolTextResult);
      expect(images).toHaveLength(1);
      return Buffer.from(images[0]!.data, "base64");
    }

    const builtInOutput = await renderWithEnvMapRef("frames-env-builtin", "studio");
    const uploadedOutput = await renderWithEnvMapRef("frames-env-uploaded", envAssetRef);

    expect(Buffer.compare(builtInOutput, uploadedOutput)).not.toBe(0);

    // Stronger than "the two renders merely differ": the built-in "studio"
    // environment is a neutral grey-toned rig (see
    // `studioEnvironmentPixel` in `@cadra/renderer`), so a metal sphere
    // reflecting it stays roughly neutral (R/G/B channels close together).
    // The uploaded HDR fixture is a saturated red/green/blue/black
    // checkerboard - if it genuinely reached the renderer, the sphere's own
    // reflection picks up real, non-neutral color (one channel clearly
    // dominant somewhere on its surface), not just "some other pixel
    // values" that could equally result from silently falling back to no
    // environment at all (this exact false positive was caught empirically:
    // an `environmentRegistry` that fails to resolve the uploaded ref still
    // produces *some* different image via the renderer's own default-lighting
    // fallback, which a bare "outputs differ" check cannot tell apart from a
    // real fix).
    const uploadedPng = PNG.sync.read(uploadedOutput);
    let maxChannelSpread = 0;
    for (let i = 0; i < uploadedPng.data.length; i += 4) {
      const r = uploadedPng.data[i]!;
      const g = uploadedPng.data[i + 1]!;
      const b = uploadedPng.data[i + 2]!;
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      maxChannelSpread = Math.max(maxChannelSpread, spread);
    }
    expect(maxChannelSpread).toBeGreaterThan(40);
  }, 30_000);
});

/**
 * Proves `render_frames`' own native-GPU-headless path actually resolves a
 * real uploaded `.cube` LUT through a `postProcessing` `lut` effect's own
 * `lutRef` - beyond the renderer's own built-in `"warm"`/`"tealOrange"`/
 * `"filmStock"` procedural looks, which is all this path previously ever
 * reached (see `buildLutRegistryForProject`'s own doc in `@cadra/encode`).
 */
describe("render_frames: real LUT (lutRef) rendering", () => {
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

  it("renders a real uploaded .cube LUT's own extreme grade (forced solid green), not the built-in look", async () => {
    try {
      const device = await createNativeGpuDevice();
      device.destroy();
    } catch (error) {
      console.log(
        "render_frames LUT e2e test: skipping, a real native WebGPU device could not be acquired on " +
          `this machine (${String(error)}).`,
      );
      return;
    }

    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-render-frames-lut-test-"));
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

    const uploadResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: buildSolidGreenCubeText().toString("base64"), contentType: "application/octet-stream" },
    });
    const uploadPayload = parseJson<UploadAssetSummary>(uploadResult as ToolTextResult);
    expect(uploadPayload.success).toBe(true);
    const lutAssetRef = uploadPayload.assetRef!;

    await connectedClient.callTool({
      name: CREATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-lut-scene",
        name: "Frames LUT scene",
        composition: { id: "comp-1", name: "Main", fps: FPS, durationInFrames: 1, width: 32, height: 32 },
      },
    });
    await connectedClient.callTool({
      name: UPDATE_SCENE_TOOL_NAME,
      arguments: {
        sceneId: "frames-lut-scene",
        mode: "replace",
        document: buildLutGradedBoxDocument("frames-lut-scene", "comp-1", 32, lutAssetRef),
      },
    });

    const result = await connectedClient.callTool({
      name: RENDER_FRAMES_TOOL_NAME,
      arguments: { sceneId: "frames-lut-scene", compositionId: "comp-1", frames: [0], seed: "frames-lut-seed" },
    });

    const summary = parseSummary(result as ToolTextResult);
    expect(summary.success).toBe(true);

    const images = imageBlocks(result as ToolTextResult);
    expect(images).toHaveLength(1);
    const png = PNG.sync.read(Buffer.from(images[0]!.data, "base64"));

    const centerPixel = pixelAt(png.data, png.width, 16, 16);
    // The solid-green LUT forces every graded pixel to (0, 255, 0),
    // regardless of the box's own gray material or the scene's own
    // lighting - only reachable if the uploaded .cube file's own bytes
    // actually made it through to the renderer.
    expect(centerPixel.g).toBeGreaterThan(200);
    expect(centerPixel.r).toBeLessThan(50);
    expect(centerPixel.b).toBeLessThan(50);
  }, 30_000);
});
