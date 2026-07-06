import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashAssetBytes } from "@cadra/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ASSET_REF_SCHEME } from "./asset-store.js";
import { LIST_ASSETS_TOOL_NAME, UPLOAD_ASSET_TOOL_NAME } from "./asset-tools.js";
import { createLogger } from "./logger.js";
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

interface UploadSuccessPayload {
  success: true;
  assetRef: string;
  hash: string;
  extension: string;
  sizeBytes: number;
  contentType?: string;
  sourceUrl?: string;
}

interface UploadFailurePayload {
  success: false;
  message: string;
}

type UploadPayload = UploadSuccessPayload | UploadFailurePayload;

interface ListAssetsPayload {
  assets: Array<{
    hash: string;
    extension: string;
    sizeBytes: number;
    assetRef: string;
    contentType?: string;
    sourceUrl?: string;
    uploadedAt: string;
  }>;
}

describe("Cadra MCP asset tools", () => {
  let workspaceRoot: string;
  let client: Client | undefined;
  let testHttpServer: Server | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-asset-tools-test-"));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await rm(workspaceRoot, { recursive: true, force: true });
    if (testHttpServer !== undefined) {
      await new Promise<void>((resolve) => testHttpServer!.close(() => resolve()));
      testHttpServer = undefined;
    }
  });

  async function connectClient(): Promise<Client> {
    const { server } = createCadraMcpServer({
      config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests.
      }),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);

    client = newClient;
    return newClient;
  }

  /** Starts an in-process HTTP server serving `body` with `contentType` at its root path, returning the URL to fetch it from. Used for the "upload by URL" test path without depending on real internet access. */
  async function startFixtureServer(body: Buffer, contentType: string): Promise<string> {
    testHttpServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": contentType });
      response.end(body);
    });
    await new Promise<void>((resolve) => testHttpServer!.listen(0, "127.0.0.1", () => resolve()));
    const address = testHttpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the fixture server to bind to a network address.");
    }
    return `http://127.0.0.1:${address.port}/fixture.png`;
  }

  it("lists the upload_asset and list_assets tools", async () => {
    const connectedClient = await connectClient();
    const { tools } = await connectedClient.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([UPLOAD_ASSET_TOOL_NAME, LIST_ASSETS_TOOL_NAME]),
    );
  });

  it("uploads an asset from raw base64 bytes and returns a cadra-asset:// ref", async () => {
    const connectedClient = await connectClient();
    const bytes = new TextEncoder().encode("hello asset bytes");
    const bytesBase64 = Buffer.from(bytes).toString("base64");

    const result = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64, contentType: "image/png" },
    });
    const payload = parseToolResult<UploadPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected upload to succeed.");
    }
    expect(payload.hash).toBe(hashAssetBytes(bytes));
    expect(payload.assetRef).toBe(`${ASSET_REF_SCHEME}${payload.hash}`);
    expect(payload.extension).toBe("png");
    expect(payload.sizeBytes).toBe(bytes.byteLength);
    expect(payload.contentType).toBe("image/png");
  });

  it("uploads an asset from a source URL, served by an in-process test HTTP server", async () => {
    const connectedClient = await connectClient();
    const body = Buffer.from("fixture image bytes served over http");
    const fixtureUrl = await startFixtureServer(body, "image/png");

    const result = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { sourceUrl: fixtureUrl },
    });
    const payload = parseToolResult<UploadPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected upload to succeed.");
    }
    expect(payload.hash).toBe(hashAssetBytes(new Uint8Array(body)));
    expect(payload.contentType).toBe("image/png");
    expect(payload.sourceUrl).toBe(fixtureUrl);
    expect(payload.extension).toBe("png");
  });

  it("uploads an asset from a data: URL fixture without depending on real internet access", async () => {
    const connectedClient = await connectClient();
    const dataUrl = `data:text/plain;base64,${Buffer.from("data url fixture bytes").toString("base64")}`;

    const result = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { sourceUrl: dataUrl },
    });
    const payload = parseToolResult<UploadPayload>(result as ToolTextResult);

    expect(payload.success).toBe(true);
    if (!payload.success) {
      throw new Error("Expected upload to succeed.");
    }
    expect(payload.hash).toBe(hashAssetBytes(new TextEncoder().encode("data url fixture bytes")));
  });

  it("rejects an upload_asset call with neither sourceUrl nor bytesBase64", async () => {
    const connectedClient = await connectClient();
    const result = await connectedClient.callTool({ name: UPLOAD_ASSET_TOOL_NAME, arguments: {} });
    const payload = parseToolResult<UploadPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
  });

  it("rejects an upload_asset call with both sourceUrl and bytesBase64", async () => {
    const connectedClient = await connectClient();
    const result = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { sourceUrl: "https://example.com/a.png", bytesBase64: "aGVsbG8=" },
    });
    const payload = parseToolResult<UploadPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
  });

  it("rejects invalid base64 bytes", async () => {
    const connectedClient = await connectClient();
    const result = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: "not valid base64 !!! ###" },
    });
    const payload = parseToolResult<UploadPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
  });

  it("reports a fetch failure for an unreachable URL", async () => {
    const connectedClient = await connectClient();
    testHttpServer = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => testHttpServer!.listen(0, "127.0.0.1", () => resolve()));
    const address = testHttpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the fixture server to bind to a network address.");
    }

    const result = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { sourceUrl: `http://127.0.0.1:${address.port}/missing.png` },
    });
    const payload = parseToolResult<UploadPayload>(result as ToolTextResult);

    expect(payload.success).toBe(false);
  });

  it("deduplicates identical bytes uploaded twice, once by bytes and once by URL", async () => {
    const connectedClient = await connectClient();
    const body = Buffer.from("shared fixture bytes for dedup test");
    const fixtureUrl = await startFixtureServer(body, "application/octet-stream");

    const byBytesResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: body.toString("base64") },
    });
    const byBytesPayload = parseToolResult<UploadPayload>(byBytesResult as ToolTextResult);

    const byUrlResult = await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { sourceUrl: fixtureUrl },
    });
    const byUrlPayload = parseToolResult<UploadPayload>(byUrlResult as ToolTextResult);

    expect(byBytesPayload.success).toBe(true);
    expect(byUrlPayload.success).toBe(true);
    if (!byBytesPayload.success || !byUrlPayload.success) {
      throw new Error("Expected both uploads to succeed.");
    }
    expect(byUrlPayload.assetRef).toBe(byBytesPayload.assetRef);

    const listResult = await connectedClient.callTool({ name: LIST_ASSETS_TOOL_NAME, arguments: {} });
    const listPayload = parseToolResult<ListAssetsPayload>(listResult as ToolTextResult);
    expect(listPayload.assets).toHaveLength(1);
  });

  it("list_assets returns an empty array when nothing has been uploaded", async () => {
    const connectedClient = await connectClient();
    const result = await connectedClient.callTool({ name: LIST_ASSETS_TOOL_NAME, arguments: {} });
    const payload = parseToolResult<ListAssetsPayload>(result as ToolTextResult);

    expect(payload.assets).toEqual([]);
  });

  it("list_assets returns metadata for every uploaded asset", async () => {
    const connectedClient = await connectClient();
    await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: Buffer.from("asset one").toString("base64"), contentType: "image/png" },
    });
    await connectedClient.callTool({
      name: UPLOAD_ASSET_TOOL_NAME,
      arguments: { bytesBase64: Buffer.from("asset two").toString("base64"), contentType: "video/mp4" },
    });

    const listResult = await connectedClient.callTool({ name: LIST_ASSETS_TOOL_NAME, arguments: {} });
    const listPayload = parseToolResult<ListAssetsPayload>(listResult as ToolTextResult);

    expect(listPayload.assets).toHaveLength(2);
    const contentTypes = listPayload.assets.map((asset) => asset.contentType).sort();
    expect(contentTypes).toEqual(["image/png", "video/mp4"]);
    for (const asset of listPayload.assets) {
      expect(asset.assetRef).toBe(`${ASSET_REF_SCHEME}${asset.hash}`);
    }
  });
});
