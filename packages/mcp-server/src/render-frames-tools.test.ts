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
  type Project,
  Satori,
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
});
