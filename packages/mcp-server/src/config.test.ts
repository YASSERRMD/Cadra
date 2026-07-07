import { describe, expect, it } from "vitest";

import {
  OUTPUT_DIRECTORY_ENV_VAR,
  PROVIDER_KEY_ENV_VAR_PREFIX,
  resolveCadraMcpServerConfig,
  WORKSPACE_ROOT_ENV_VAR,
} from "./config.js";

/** A minimal `NodeJS.ProcessEnv`-shaped object for tests, so no test ever touches the real `process.env`. */
function fakeEnv(vars: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return vars as NodeJS.ProcessEnv;
}

describe("resolveCadraMcpServerConfig", () => {
  it("falls back to process.cwd() for workspaceRoot when no input or env var is given", () => {
    const config = resolveCadraMcpServerConfig({}, fakeEnv({}));
    expect(config.workspaceRoot).toBe(process.cwd());
  });

  it("derives outputDirectory from workspaceRoot when no input or env var is given", () => {
    const config = resolveCadraMcpServerConfig({ workspaceRoot: "/workspace" }, fakeEnv({}));
    expect(config.outputDirectory).toBe("/workspace/.cadra/output");
  });

  it("returns an empty providerKeys object when none are configured", () => {
    const config = resolveCadraMcpServerConfig({}, fakeEnv({}));
    expect(config.providerKeys).toEqual({});
  });

  it("prefers explicit input over environment variables for every field", () => {
    const config = resolveCadraMcpServerConfig(
      {
        workspaceRoot: "/explicit/workspace",
        outputDirectory: "/explicit/output",
        providerKeys: { veo: "explicit-key" },
      },
      fakeEnv({
        [WORKSPACE_ROOT_ENV_VAR]: "/env/workspace",
        [OUTPUT_DIRECTORY_ENV_VAR]: "/env/output",
        [`${PROVIDER_KEY_ENV_VAR_PREFIX}VEO`]: "env-key",
      }),
    );

    expect(config).toEqual({
      workspaceRoot: "/explicit/workspace",
      outputDirectory: "/explicit/output",
      providerKeys: { veo: "explicit-key" },
    });
  });

  it("reads workspaceRoot and outputDirectory from environment variables when no input is given", () => {
    const config = resolveCadraMcpServerConfig(
      {},
      fakeEnv({
        [WORKSPACE_ROOT_ENV_VAR]: "/env/workspace",
        [OUTPUT_DIRECTORY_ENV_VAR]: "/env/output",
      }),
    );

    expect(config.workspaceRoot).toBe("/env/workspace");
    expect(config.outputDirectory).toBe("/env/output");
  });

  it("collects CADRA_PROVIDER_KEY_* environment variables into a lowercased providerKeys bag", () => {
    const config = resolveCadraMcpServerConfig(
      {},
      fakeEnv({
        [`${PROVIDER_KEY_ENV_VAR_PREFIX}VEO`]: "veo-key",
        [`${PROVIDER_KEY_ENV_VAR_PREFIX}RUNWAY`]: "runway-key",
        UNRELATED_VAR: "ignored",
      }),
    );

    expect(config.providerKeys).toEqual({ veo: "veo-key", runway: "runway-key" });
  });

  it("ignores a provider key environment variable with an empty provider id", () => {
    const config = resolveCadraMcpServerConfig(
      {},
      fakeEnv({ [PROVIDER_KEY_ENV_VAR_PREFIX]: "orphan-key" }),
    );
    expect(config.providerKeys).toEqual({});
  });

  it("input.providerKeys replaces environment-derived provider keys rather than merging with them", () => {
    const config = resolveCadraMcpServerConfig(
      { providerKeys: { luma: "luma-key" } },
      fakeEnv({ [`${PROVIDER_KEY_ENV_VAR_PREFIX}VEO`]: "veo-key" }),
    );

    expect(config.providerKeys).toEqual({ luma: "luma-key" });
  });

  it("reads CADRA_PROVIDER_KEY_ANTHROPIC into providerKeys.anthropic, exactly like any other provider (Phase 32's first real consumer of this bag)", () => {
    const config = resolveCadraMcpServerConfig(
      {},
      fakeEnv({ [`${PROVIDER_KEY_ENV_VAR_PREFIX}ANTHROPIC`]: "anthropic-key" }),
    );

    expect(config.providerKeys).toEqual({ anthropic: "anthropic-key" });
  });
});
