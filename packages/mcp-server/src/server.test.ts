import { describe, expect, it } from "vitest";

import { createCadraMcpServer, PING_TOOL_NAME, SERVER_NAME, SERVER_VERSION } from "./server.js";

describe("createCadraMcpServer", () => {
  it("returns a server that is not yet connected to any transport", () => {
    const { server } = createCadraMcpServer();
    expect(server.isConnected()).toBe(false);
  });

  it("resolves configuration from the given options", () => {
    const { config } = createCadraMcpServer({
      config: { workspaceRoot: "/ws", outputDirectory: "/ws/out", providerKeys: { veo: "key" } },
    });

    expect(config).toEqual({
      workspaceRoot: "/ws",
      outputDirectory: "/ws/out",
      providerKeys: { veo: "key" },
    });
  });

  it("uses the given logger instead of constructing its own", () => {
    const lines: string[] = [];
    const logger = {
      debug: () => {},
      info: (message: string) => lines.push(message),
      warn: () => {},
      error: () => {},
      child: () => logger,
    };

    createCadraMcpServer({ logger });
    expect(lines).toContain("Cadra MCP server constructed");
  });

  it("constructs without throwing when given a full set of real video-provider keys, including kling's two-key pair", () => {
    expect(() =>
      createCadraMcpServer({
        config: {
          providerKeys: {
            veo: "veo-key",
            runway: "runway-key",
            luma: "luma-key",
            pika: "pika-key",
            kling_access: "kling-ak",
            kling_secret: "kling-sk",
          },
        },
      }),
    ).not.toThrow();
  });

  it("advertises a stable name/version for the MCP handshake", () => {
    expect(SERVER_NAME).toBe("cadra-mcp-server");
    expect(SERVER_VERSION).toBe("0.0.0");
  });

  it("names the placeholder diagnostic tool 'ping'", () => {
    expect(PING_TOOL_NAME).toBe("ping");
  });
});
