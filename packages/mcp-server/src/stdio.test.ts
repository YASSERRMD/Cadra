import { describeCadraContract } from "@cadra/schema";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { CADRA_CONTRACT_RESOURCE_URI } from "./contract-resource.js";
import { createLogger } from "./logger.js";
import { createCadraMcpServer, PING_TOOL_NAME, SERVER_NAME, SERVER_VERSION } from "./server.js";

/** Narrows a `resources/read` content entry to its text variant, throwing if it turns out to be a blob. Every resource this server registers is text (`application/json`), so a blob here would indicate a real bug, not an expected branch. */
function expectTextContent(content: { text: string } | { blob: string }): string {
  if (!("text" in content)) {
    throw new Error("Expected text content, got blob content.");
  }
  return content.text;
}

/**
 * These tests exercise the exact same `McpServer` this package's stdio
 * entrypoint (`./stdio.ts`) connects to a `StdioServerTransport`, but paired
 * with the SDK's own `InMemoryTransport.createLinkedPair()` instead of a real
 * `StdioServerTransport` talking to a spawned child process.
 *
 * This is a faithful stand-in for the stdio transport, not a weaker one: both
 * transports implement the same `Transport` interface and carry the same
 * newline-delimited JSON-RPC frames; `InMemoryTransport` simply hands
 * messages directly between a `Client` and a `Server` in one process instead
 * of relaying them through real OS pipes. What stdio adds on top (reading
 * `process.stdin`, writing `process.stdout`) is exercised structurally by
 * this package's stdio/stdout-safety guarantee, covered separately in
 * `./logger.test.ts` (every log line goes through `stderr`, never `stdout`,
 * regardless of transport).
 */
describe("Cadra MCP server over an in-memory (stdio-equivalent) transport", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  async function connectClientAndServer(): Promise<Client> {
    const { server } = createCadraMcpServer({
      config: { workspaceRoot: "/workspace", outputDirectory: "/workspace/out" },
      logger: createLogger("test", {}, () => {
        // Swallow log output in tests; logger behavior itself is covered by logger.test.ts.
      }),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const newClient = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([server.connect(serverTransport), newClient.connect(clientTransport)]);

    client = newClient;
    return newClient;
  }

  it("completes the MCP initialize handshake and reports this server's identity", async () => {
    const connectedClient = await connectClientAndServer();

    const serverVersion = connectedClient.getServerVersion();
    expect(serverVersion).toMatchObject({ name: SERVER_NAME, version: SERVER_VERSION });
  });

  it("advertises the resources capability", async () => {
    const connectedClient = await connectClientAndServer();

    const capabilities = connectedClient.getServerCapabilities();
    expect(capabilities?.resources).toBeDefined();
  });

  it("lists the cadra://contract resource", async () => {
    const connectedClient = await connectClientAndServer();

    const { resources } = await connectedClient.listResources();
    const contractResource = resources.find(
      (resource) => resource.uri === CADRA_CONTRACT_RESOURCE_URI,
    );

    expect(contractResource).toBeDefined();
    expect(contractResource?.mimeType).toBe("application/json");
  });

  it("reads the cadra://contract resource and returns describeCadraContract()'s exact output", async () => {
    const connectedClient = await connectClientAndServer();

    const { contents } = await connectedClient.readResource({ uri: CADRA_CONTRACT_RESOURCE_URI });
    expect(contents).toHaveLength(1);

    const [content] = contents;
    expect(content).toBeDefined();
    expect(content?.mimeType).toBe("application/json");

    const text = expectTextContent(content!);
    const parsedContract = JSON.parse(text);
    expect(parsedContract).toEqual(describeCadraContract());
  });

  it("calling the placeholder ping tool echoes back workspace/output configuration", async () => {
    const connectedClient = await connectClientAndServer();

    const result = await connectedClient.callTool({
      name: PING_TOOL_NAME,
      arguments: { requestId: "req-1" },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    const payload = JSON.parse(content[0]!.text);
    expect(payload).toEqual({
      status: "ok",
      requestId: "req-1",
      workspaceRoot: "/workspace",
      outputDirectory: "/workspace/out",
    });
  });
});
