import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeCadraContract } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { UPLOAD_ASSET_TOOL_NAME } from "./asset-tools.js";
import { CADRA_CONTRACT_RESOURCE_URI } from "./contract-resource.js";
import {
  ASSET_BYTES_PATH,
  type CadraMcpHttpServer,
  DEFAULT_MCP_PATH,
  HEALTH_CHECK_PATH,
  startCadraMcpServerHttp,
} from "./http.js";
import { createLogger } from "./logger.js";
import { PING_TOOL_NAME, SERVER_NAME, SERVER_VERSION } from "./server.js";

/** Narrows a `resources/read` content entry to its text variant, throwing if it turns out to be a blob. Every resource this server registers is text (`application/json`), so a blob here would indicate a real bug, not an expected branch. */
function expectTextContent(content: { text: string } | { blob: string }): string {
  if (!("text" in content)) {
    throw new Error("Expected text content, got blob content.");
  }
  return content.text;
}

/**
 * These tests start a real `node:http` server (an ephemeral OS-assigned
 * port, `127.0.0.1` only) and connect to it with the SDK's own `Client` over
 * a real `StreamableHTTPClientTransport`, exercising the exact same code
 * path a real MCP-capable agent would use to reach this server over the
 * network: real HTTP requests/responses, not an in-memory stand-in.
 */
describe("Cadra MCP server over Streamable HTTP", () => {
  let httpServer: CadraMcpHttpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await httpServer?.close();
    httpServer = undefined;
  });

  async function startServerAndClient(): Promise<{
    server: CadraMcpHttpServer;
    connectedClient: Client;
  }> {
    const server = await startCadraMcpServerHttp({
      config: { workspaceRoot: "/workspace", outputDirectory: "/workspace/out" },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests; logger behavior itself is covered by logger.test.ts.
      }),
    });
    httpServer = server;

    const newClient = new Client({ name: "test-http-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_MCP_PATH, server.url));
    await newClient.connect(transport);
    client = newClient;

    return { server, connectedClient: newClient };
  }

  it("responds 200 on GET /health with server identity, with no MCP session required", async () => {
    const server = await startCadraMcpServerHttp({
      logger: createLogger("test", {}, () => {
        // no-op sink
      }),
    });
    httpServer = server;

    const response = await fetch(new URL(HEALTH_CHECK_PATH, server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body).toEqual({ status: "ok", server: SERVER_NAME, version: SERVER_VERSION });
  });

  it("responds 404 for an unknown path", async () => {
    const server = await startCadraMcpServerHttp({
      logger: createLogger("test", {}, () => {
        // no-op sink
      }),
    });
    httpServer = server;

    const response = await fetch(new URL("/does-not-exist", server.url));
    expect(response.status).toBe(404);
  });

  it("completes the MCP initialize handshake over a real HTTP connection", async () => {
    const { connectedClient } = await startServerAndClient();

    const serverVersion = connectedClient.getServerVersion();
    expect(serverVersion).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
  });

  it("lists the cadra://contract resource over HTTP", async () => {
    const { connectedClient } = await startServerAndClient();

    const { resources } = await connectedClient.listResources();
    const contractResource = resources.find(
      (resource) => resource.uri === CADRA_CONTRACT_RESOURCE_URI,
    );

    expect(contractResource).toBeDefined();
    expect(contractResource?.mimeType).toBe("application/json");
  });

  it("reads the cadra://contract resource over HTTP and returns describeCadraContract()'s exact output", async () => {
    const { connectedClient } = await startServerAndClient();

    const { contents } = await connectedClient.readResource({ uri: CADRA_CONTRACT_RESOURCE_URI });
    expect(contents).toHaveLength(1);

    const [content] = contents;
    expect(content).toBeDefined();
    expect(content?.mimeType).toBe("application/json");

    const text = expectTextContent(content!);
    const parsedContract = JSON.parse(text);
    expect(parsedContract).toEqual(describeCadraContract());
  });

  it("calling the placeholder ping tool over HTTP echoes back workspace/output configuration", async () => {
    const { connectedClient } = await startServerAndClient();

    const result = await connectedClient.callTool({
      name: PING_TOOL_NAME,
      arguments: { requestId: "http-req-1" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const payload = JSON.parse(content[0]!.text);
    expect(payload).toEqual({
      status: "ok",
      requestId: "http-req-1",
      workspaceRoot: "/workspace",
      outputDirectory: "/workspace/out",
    });
  });

  /**
   * These tests need a real (not `"/workspace"`, which is never actually
   * read from disk by the tests above) workspace root: the asset-bytes route
   * reads real files back off disk via `./asset-store.js`, so a fake path
   * would 404 for reasons unrelated to what is under test.
   */
  describe("GET /assets", () => {
    let workspaceRoot: string | undefined;

    afterEach(async () => {
      if (workspaceRoot !== undefined) {
        await rm(workspaceRoot, { recursive: true, force: true });
        workspaceRoot = undefined;
      }
    });

    async function startServerWithRealWorkspace(): Promise<{
      server: CadraMcpHttpServer;
      connectedClient: Client;
    }> {
      workspaceRoot = await mkdtemp(join(tmpdir(), "cadra-http-assets-test-"));
      const server = await startCadraMcpServerHttp({
        config: { workspaceRoot, outputDirectory: join(workspaceRoot, "out") },
        logger: createLogger("test", {}, () => {
          // no-op sink
        }),
      });
      httpServer = server;

      const newClient = new Client({ name: "test-http-client", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(DEFAULT_MCP_PATH, server.url));
      await newClient.connect(transport);
      client = newClient;

      return { server, connectedClient: newClient };
    }

    /** Builds `GET {ASSET_BYTES_PATH}?ref=<ref>` against `server`, omitting the query string entirely when `ref` is `undefined` (the "missing ref" case). */
    function buildAssetUrl(server: CadraMcpHttpServer, ref: string | undefined): URL {
      const url = new URL(ASSET_BYTES_PATH, server.url);
      if (ref !== undefined) {
        url.searchParams.set("ref", ref);
      }
      return url;
    }

    it("streams back a real uploaded asset's own exact bytes and content type", async () => {
      const { server, connectedClient } = await startServerWithRealWorkspace();

      const sourceBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const uploadResult = await connectedClient.callTool({
        name: UPLOAD_ASSET_TOOL_NAME,
        arguments: {
          bytesBase64: Buffer.from(sourceBytes).toString("base64"),
          contentType: "application/octet-stream",
        },
      });
      const uploadContent = uploadResult.content as Array<{ type: string; text: string }>;
      const uploadPayload = JSON.parse(uploadContent[0]!.text) as { assetRef: string };

      const response = await fetch(buildAssetUrl(server, uploadPayload.assetRef));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("cache-control")).toContain("immutable");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");

      const responseBytes = new Uint8Array(await response.arrayBuffer());
      expect(Array.from(responseBytes)).toEqual(Array.from(sourceBytes));
    });

    it("responds 404 for a well-formed ref that was never uploaded", async () => {
      const { server } = await startServerWithRealWorkspace();

      const response = await fetch(buildAssetUrl(server, "cadra-asset://does-not-exist"));
      expect(response.status).toBe(404);
    });

    it("responds 404 for a ref outside the cadra-asset:// scheme", async () => {
      const { server } = await startServerWithRealWorkspace();

      const response = await fetch(buildAssetUrl(server, "https://example.com/x.png"));
      expect(response.status).toBe(404);
    });

    it("responds 400 when the ref query parameter is missing entirely", async () => {
      const { server } = await startServerWithRealWorkspace();

      const response = await fetch(buildAssetUrl(server, undefined));
      expect(response.status).toBe(400);
    });

    it("answers a CORS preflight OPTIONS request with a permissive allow-origin", async () => {
      const { server } = await startServerWithRealWorkspace();

      const response = await fetch(buildAssetUrl(server, undefined), { method: "OPTIONS" });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    });
  });
});
