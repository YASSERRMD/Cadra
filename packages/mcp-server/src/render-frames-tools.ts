/**
 * `render_frames`: renders a handful of specific frames of an existing
 * scene's composition and returns them in-band as PNG image content, so an
 * agent can actually see pixels through a tool result instead of rendering
 * a full video job and separately extracting frames with an out-of-band
 * `ffmpeg` call (the exact workaround this tool replaces).
 *
 * Renders through `@cadra/headless`'s `createNativeGpuHeadlessRenderer`
 * (real Dawn-backed WebGPU, no browser process; the same path
 * `@cadra/golden-frames`' whole visual-regression suite already depends on
 * in this exact codebase, CI included), not `render_scene`'s own bundled-
 * browser-page range pipeline: no video encode/mux, no job to poll, and a
 * fresh renderer per call is fast enough for the handful of frames this
 * tool is meant for. Text nodes are prepared exactly like `render_scene`'s
 * own real render path (`@cadra/encode`'s `buildTextRenderRegistryForProject`,
 * shared with `render-job.ts` so the two paths can never silently diverge
 * on how text renders). Image nodes are prepared via that same package's
 * `buildTextureRegistryForProject` instead - a same-process, Node-only-PNG-
 * decoder counterpart to `render_scene`'s own browser-`createImageBitmap`-
 * based path (`browser-headless-render-entry.ts`'s `buildTextureRegistry`),
 * since this tool's whole point is having no browser page to decode in at
 * all; any non-PNG asset (or corrupt PNG bytes) falls back to the
 * renderer's own documented gray placeholder instead of failing the call,
 * exactly like an unresolved `assetRef` already does. Satori (`"satori"`
 * scene nodes) are prepared via `buildSatoriLayerRenderRegistryForProject`,
 * pre-rendered and rasterized at every one of this call's own `frames`
 * (unlike text/image, a satori layer's own pixels can vary by frame - see
 * that function's own doc). Model nodes (`"model"` scene nodes, glTF/GLB)
 * are prepared via `buildModelRegistryForProject`, matching `render_scene`'s
 * own real browser-based render path (both resolve `ModelNode` assets the
 * same way). A composition's own `environment.envMapRef`/`postProcessing`
 * `lut` effect are prepared via `buildEnvironmentRegistryForProject`/
 * `buildLutRegistryForProject` - real uploaded HDR/`.cube` assets, beyond
 * the renderer's own built-in procedural `"studio"`/`"outdoor"` environments
 * and `"warm"`/`"tealOrange"`/`"filmStock"` looks.
 */
import type { Project } from "@cadra/core";
import { createFrameContext, resolveSceneAtFrame } from "@cadra/core";
import {
  buildEnvironmentRegistryForProject,
  buildLutRegistryForProject,
  buildModelRegistryForProject,
  buildSatoriLayerRenderRegistryForProject,
  buildTextRenderRegistryForProject,
  buildTextureRegistryForProject,
} from "@cadra/encode";
import {
  createNativeGpuHeadlessRenderer,
  NativeGpuAdapterUnavailableError,
} from "@cadra/headless";
import type { PixelBuffer, PixelReadableRenderer, RenderTarget } from "@cadra/renderer";
import { parseScene } from "@cadra/schema";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PNG } from "pngjs";
import { z } from "zod";

import { createAssetBytesFetcher } from "./asset-store.js";
import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { readSceneFile, sanitizeSceneId } from "./scene-store.js";

/** Registered tool name for rendering specific frames as in-band PNGs. */
export const RENDER_FRAMES_TOOL_NAME = "render_frames";

/**
 * Upper bound on frames per call: this tool exists for quick visual spot
 * checks (first/mid/last, a suspect range), not as a bulk-export path -
 * `render_scene` already covers "the whole composition, encoded" far more
 * efficiently than N individually-rendered-and-PNG-encoded frames ever
 * could. Keeps one call's response size and render time bounded regardless
 * of how large a caller's `frames` array is.
 */
export const MAX_FRAMES_PER_RENDER_FRAMES_CALL = 12;

/** A `{ success: false, message }` tool result payload, matching `render-tools.ts`'s own established shape. */
interface RenderFramesFailurePayload {
  success: false;
  message: string;
}

/** `render_frames`' success payload's leading text block: metadata about the images that follow. */
interface RenderFramesSuccessSummary {
  success: true;
  sceneId: string;
  compositionId: string;
  width: number;
  height: number;
  frames: number[];
}

/** Encodes a `PixelBuffer` (top-left origin, RGBA8) to PNG bytes; mirrors `@cadra/golden-frames`' own `encodePixelBufferToPng`, duplicated here rather than depending on that test-harness package from a production one. */
function encodePixelBufferToPng(pixels: PixelBuffer): Buffer {
  const png = new PNG({ width: pixels.width, height: pixels.height });
  png.data = Buffer.from(pixels.data);
  return PNG.sync.write(png);
}

/** Renders one `frame` of `project`'s `compositionId` through `renderer` (already `init()`ed at the composition's own size) and returns its PNG bytes. */
function renderOneFramePng(
  renderer: PixelReadableRenderer,
  project: Project,
  compositionId: string,
  frame: number,
  fps: number,
  durationInFrames: number,
  seed: string | number,
): Promise<Buffer> {
  const sceneState = resolveSceneAtFrame(project, compositionId, frame);
  const frameContext = createFrameContext({ frame, fps, durationInFrames, seed });
  renderer.renderFrame(sceneState, frameContext);
  return Promise.resolve(renderer.readPixels()).then(encodePixelBufferToPng);
}

/**
 * Registers `render_frames` on `server`.
 */
export function registerCadraRenderFramesTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
): RegisteredTool[] {
  const toolLogger = logger.child("render-frames-tools");

  const renderFramesTool = server.registerTool(
    RENDER_FRAMES_TOOL_NAME,
    {
      title: "Render frames",
      description:
        "Renders specific frames of an existing scene's composition and returns them as " +
        "in-band PNG images, so you can actually see the result instead of only getting a " +
        `video file path. Bounded at ${MAX_FRAMES_PER_RENDER_FRAMES_CALL} frames per call - use ` +
        "this for spot checks (first/middle/last frame, a suspect range), not as a bulk export; " +
        "use render_scene for the full, encoded composition. Renders through an experimental " +
        "no-browser native-GPU path: on a machine with no usable GPU/software-Vulkan device, " +
        "this fails with an actionable diagnostic rather than a raw crash - render_scene's " +
        "browser-based path remains available either way.",
      inputSchema: {
        sceneId: z.string().describe("Id of the scene (as persisted by create_scene/update_scene) to render."),
        compositionId: z.string().describe("Id of the composition, within that scene, to render."),
        frames: z
          .array(z.number().int().nonnegative())
          .min(1)
          .max(MAX_FRAMES_PER_RENDER_FRAMES_CALL)
          .describe(
            `Which integer frames to render, in the order given (max ${MAX_FRAMES_PER_RENDER_FRAMES_CALL} per call). ` +
              "Each must be within [0, durationInFrames) for the target composition.",
          ),
        seed: z
          .union([z.string(), z.number()])
          .describe("Base seed for every frame's rendering; the same seed renders deterministically."),
      },
    },
    async ({ sceneId, compositionId, frames, seed }) => {
      const idValidation = sanitizeSceneId(sceneId);
      if (!idValidation.valid) {
        return jsonAndImages({ success: false, message: idValidation.reason });
      }

      const file = await readSceneFile(config.workspaceRoot, idValidation.sceneId);
      if (file === undefined) {
        return jsonAndImages({
          success: false,
          message:
            `No scene with id "${idValidation.sceneId}" was found in this workspace. Call ` +
            "list_scenes to see every scene id currently persisted, or create_scene to create it first.",
        });
      }

      const parsed = parseScene(file.raw);
      if (!parsed.success) {
        return jsonAndImages({
          success: false,
          message:
            `Scene "${idValidation.sceneId}" is persisted but no longer validates against the ` +
            "current scene schema; call get_scene or validate_scene for full diagnostics.",
        });
      }

      const composition = parsed.document.project.compositions.find((c) => c.id === compositionId);
      if (composition === undefined) {
        const availableIds = parsed.document.project.compositions.map((c) => c.id);
        return jsonAndImages({
          success: false,
          message:
            `Scene "${idValidation.sceneId}" has no composition with id "${compositionId}". ` +
            `Available composition ids: ${availableIds.length > 0 ? availableIds.join(", ") : "(none)"}.`,
        });
      }

      const outOfRange = frames.filter((frame) => frame >= composition.durationInFrames);
      if (outOfRange.length > 0) {
        return jsonAndImages({
          success: false,
          message:
            `Requested frame(s) ${outOfRange.join(", ")} are outside composition "${compositionId}"'s ` +
            `own [0, ${composition.durationInFrames}) frame range.`,
        });
      }

      const project = parsed.document.project;
      let renderer: PixelReadableRenderer | undefined;

      try {
        const textRenderRegistry = await buildTextRenderRegistryForProject(project);
        const textureRegistry = await buildTextureRegistryForProject(
          project,
          createAssetBytesFetcher(config.workspaceRoot),
        );
        const satoriLayerRenderRegistry = await buildSatoriLayerRenderRegistryForProject(project, frames);
        const modelRegistry = await buildModelRegistryForProject(
          project,
          createAssetBytesFetcher(config.workspaceRoot),
        );
        const environmentRegistry = await buildEnvironmentRegistryForProject(
          project,
          createAssetBytesFetcher(config.workspaceRoot),
        );
        const lutRegistry = await buildLutRegistryForProject(
          project,
          createAssetBytesFetcher(config.workspaceRoot),
        );
        renderer = createNativeGpuHeadlessRenderer({
          textRenderRegistry,
          textureRegistry,
          satoriLayerRenderRegistry,
          modelRegistry,
          environmentRegistry,
          lutRegistry,
        });

        await renderer.init(
          {} as unknown as RenderTarget,
          { width: composition.width, height: composition.height },
        );

        const pngs: Buffer[] = [];
        for (const frame of frames) {
          pngs.push(
            await renderOneFramePng(
              renderer,
              project,
              compositionId,
              frame,
              composition.fps,
              composition.durationInFrames,
              seed,
            ),
          );
        }

        toolLogger.info("render_frames rendered frames", {
          sceneId: idValidation.sceneId,
          compositionId,
          frameCount: frames.length,
        });

        return jsonAndImages(
          {
            success: true,
            sceneId: idValidation.sceneId,
            compositionId,
            width: composition.width,
            height: composition.height,
            frames,
          },
          pngs,
        );
      } catch (error) {
        if (error instanceof NativeGpuAdapterUnavailableError) {
          toolLogger.warn("render_frames: no native GPU adapter available on this machine", {
            sceneId: idValidation.sceneId,
            compositionId,
          });
          return jsonAndImages({
            success: false,
            message:
              "render_frames could not acquire a native GPU device on this machine (no usable " +
              "hardware or software-Vulkan/Metal/D3D12 adapter found). This is a known limitation " +
              "of this tool's experimental no-browser render path, not a problem with the scene " +
              "itself; use render_scene (its browser-based path always has a software-rendering " +
              "fallback) to render this composition instead.",
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        toolLogger.error("render_frames failed", { sceneId: idValidation.sceneId, compositionId, message });
        return jsonAndImages({ success: false, message });
      } finally {
        // undefined if registry preparation itself threw before
        // createNativeGpuHeadlessRenderer was ever called - nothing to
        // dispose in that case.
        renderer?.dispose();
      }
    },
  );

  return [renderFramesTool];
}

/** Builds `render_frames`' own tool result: one JSON text summary block, followed by one image block per rendered PNG (empty on failure). */
function jsonAndImages(
  summary: RenderFramesFailurePayload | RenderFramesSuccessSummary,
  pngs: Buffer[] = [],
): { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> } {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(summary) },
      ...pngs.map((png) => ({
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      })),
    ],
  };
}
