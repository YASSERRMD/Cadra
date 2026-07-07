/**
 * MCP tools for uploading and listing content-addressed assets:
 * `upload_asset` and `list_assets`. Persists asset bytes under this server's
 * configured `workspaceRoot` via `./asset-store.ts`, which applies the same
 * allow-list-plus-resolved-path-check sandboxing discipline
 * `scene-store.ts` established for scene ids, keyed here by content hash
 * instead of a caller-supplied id (see that module's own doc for why a
 * hash-derived path can never itself be a path-traversal vector).
 *
 * `upload_asset` accepts exactly one of two sources: `sourceUrl` (ingested
 * via `./asset-store.ts`'s `ingestAssetFromUrl`, fetched with Node's
 * built-in `fetch`) or `bytesBase64` (raw bytes, base64-encoded since MCP
 * tool inputs are JSON). Either way, the fetched/decoded bytes are hashed
 * with `@cadra/core`'s `hashAssetBytes` (this codebase's sole standardized
 * content-hashing primitive) and stored once, deduplicating automatically:
 * re-uploading identical bytes resolves to the same asset ref rather than
 * creating a second copy. `ingestAssetFromUrl` is the same function
 * `./generation-asset-binding.ts` (Phase 36) calls to turn a finished
 * generation job's vendor-hosted output URL into a real, durable asset ref,
 * so a URL becomes a stored asset exactly one way in this codebase,
 * regardless of whether an agent supplied it directly or a generation job
 * produced it.
 */
import { hashAssetBytes } from "@cadra/core";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  buildAssetRef,
  ingestAssetFromUrl,
  listStoredAssets,
  resolveAssetExtension,
  writeAssetFile,
} from "./asset-store.js";
import type { CadraMcpServerConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** Registered tool name for uploading an asset by URL or raw bytes. */
export const UPLOAD_ASSET_TOOL_NAME = "upload_asset";
/** Registered tool name for listing every stored asset. */
export const LIST_ASSETS_TOOL_NAME = "list_assets";

/** Wraps a JSON-serializable payload as a single-text-block MCP tool result, matching the convention `scene-tools.ts` already established. */
function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** A `{ success: false, message }` tool result payload, shared by every failure mode this module can produce. */
interface AssetToolFailurePayload {
  success: false;
  message: string;
}

/** A `{ success: true, assetRef, hash, sizeBytes, contentType?, sourceUrl? }` tool result payload `upload_asset` returns on success. */
interface UploadAssetSuccessPayload {
  success: true;
  assetRef: string;
  hash: string;
  extension: string;
  sizeBytes: number;
  contentType?: string;
  sourceUrl?: string;
}

/**
 * Decodes `bytesBase64` into raw bytes, throwing a caller-facing error
 * (rather than propagating an opaque `Buffer` decoding failure) if it is not
 * valid base64.
 */
function decodeBase64AssetBytes(bytesBase64: string): Uint8Array {
  const buffer = Buffer.from(bytesBase64, "base64");
  // Buffer.from(..., "base64") silently drops invalid characters rather than
  // throwing; re-encoding and comparing catches a malformed input (e.g.
  // plain text mistakenly passed as bytesBase64) instead of silently storing
  // truncated/garbage bytes.
  const roundTripped = buffer.toString("base64");
  const normalizedInput = bytesBase64.replace(/\s+/g, "");
  if (roundTripped.replace(/=+$/, "") !== normalizedInput.replace(/=+$/, "")) {
    throw new Error("upload_asset: bytesBase64 is not valid base64.");
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/**
 * Registers `upload_asset` and `list_assets` on `server`, persisting asset
 * bytes content-addressed under `config.workspaceRoot`'s `assets` directory
 * (see `./asset-store.ts`).
 */
export function registerCadraAssetTools(
  server: McpServer,
  config: CadraMcpServerConfig,
  logger: Logger,
): RegisteredTool[] {
  const toolLogger = logger.child("asset-tools");

  const uploadAssetTool = server.registerTool(
    UPLOAD_ASSET_TOOL_NAME,
    {
      title: "Upload asset",
      description:
        "Uploads an asset (image, video, audio, font, or glTF model) from either a source URL " +
        "or raw base64-encoded bytes, hashes its content, and stores it once under this " +
        "server's workspace, deduplicating identical uploads. Returns a 'cadra-asset://<hash>' " +
        "ref that can be placed directly into a scene node's assetRef field (e.g. an image " +
        "node's assetRef, or an audio clip's assetRef).",
      inputSchema: {
        sourceUrl: z
          .string()
          .optional()
          .describe(
            "URL to fetch the asset's bytes from. Exactly one of sourceUrl or bytesBase64 must " +
              "be given.",
          ),
        bytesBase64: z
          .string()
          .optional()
          .describe(
            "Raw asset bytes, base64-encoded. Exactly one of sourceUrl or bytesBase64 must be " +
              "given.",
          ),
        contentType: z
          .string()
          .optional()
          .describe(
            "MIME type of the asset (e.g. 'image/png'), used to pick a file extension. If " +
              "omitted, inferred from the URL response's own Content-Type header (when " +
              "uploading by URL) or sniffed from sourceUrl's own extension; falls back to a " +
              "generic extension if neither is available.",
          ),
      },
    },
    async ({ sourceUrl, bytesBase64, contentType }) => {
      if ((sourceUrl === undefined) === (bytesBase64 === undefined)) {
        return jsonResult({
          success: false,
          message:
            "upload_asset requires exactly one of sourceUrl or bytesBase64, not both or neither.",
        } satisfies AssetToolFailurePayload);
      }

      if (sourceUrl !== undefined) {
        let summary;
        try {
          summary = await ingestAssetFromUrl(config.workspaceRoot, sourceUrl, contentType);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          toolLogger.warn("upload_asset failed to obtain bytes", { sourceUrl, message });
          return jsonResult({ success: false, message } satisfies AssetToolFailurePayload);
        }

        toolLogger.info("upload_asset stored a new asset", {
          hash: summary.hash,
          sizeBytes: summary.sizeBytes,
          extension: summary.extension,
          viaUrl: true,
        });

        return jsonResult({
          success: true,
          assetRef: summary.assetRef,
          hash: summary.hash,
          extension: summary.extension,
          sizeBytes: summary.sizeBytes,
          ...(summary.contentType !== undefined ? { contentType: summary.contentType } : {}),
          ...(summary.sourceUrl !== undefined ? { sourceUrl: summary.sourceUrl } : {}),
        } satisfies UploadAssetSuccessPayload);
      }

      let bytes: Uint8Array;
      try {
        bytes = decodeBase64AssetBytes(bytesBase64!);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toolLogger.warn("upload_asset failed to obtain bytes", { message });
        return jsonResult({ success: false, message } satisfies AssetToolFailurePayload);
      }

      const hash = hashAssetBytes(bytes);
      const extension = resolveAssetExtension(contentType, undefined);

      const metadata = await writeAssetFile(config.workspaceRoot, hash, extension, bytes, {
        ...(contentType !== undefined ? { contentType } : {}),
      });

      toolLogger.info("upload_asset stored a new asset", {
        hash,
        sizeBytes: metadata.sizeBytes,
        extension,
        viaUrl: false,
      });

      return jsonResult({
        success: true,
        assetRef: buildAssetRef(hash),
        hash,
        extension: metadata.extension,
        sizeBytes: metadata.sizeBytes,
        ...(metadata.contentType !== undefined ? { contentType: metadata.contentType } : {}),
        ...(metadata.sourceUrl !== undefined ? { sourceUrl: metadata.sourceUrl } : {}),
      } satisfies UploadAssetSuccessPayload);
    },
  );

  const listAssetsTool = server.registerTool(
    LIST_ASSETS_TOOL_NAME,
    {
      title: "List assets",
      description:
        "Lists every asset currently stored in this server's workspace, with enough metadata " +
        "(content hash, size, content type, source URL if uploaded by URL, and the ref usable in " +
        "a scene) to be useful without embedding the full bytes of every asset in the response.",
      inputSchema: {},
    },
    async () => {
      const assets = await listStoredAssets(config.workspaceRoot);
      return jsonResult({ assets });
    },
  );

  return [uploadAssetTool, listAssetsTool];
}
