/**
 * Typed runtime configuration for the Cadra MCP server: where an agent's
 * scene/asset files live, where rendered output should be written, and a
 * bag of provider API keys (LLM and, eventually, generative-video).
 *
 * This phase (28) only needs a clean, typed place for this configuration to
 * live; `workspaceRoot` and `outputDirectory` are not yet read by any
 * scene-authoring or render tool (those land in Phase 29 and Phase 30), and
 * `providerKeys` is not wired up to any actual provider yet. Nothing here
 * validates that a path exists or a key is well-formed; that is deferred to
 * whichever later phase first needs to act on a given field.
 *
 * Phase 32 is `providerKeys`' first real consumer: `providerKeys.anthropic`,
 * if set, is passed as the API key for `generate_scene_from_text`'s default
 * `@anthropic-ai/sdk`-backed text-to-scene adapter (see
 * `./text-to-scene-tools.ts`). Populate it either via an explicit
 * `config.providerKeys.anthropic` option or the
 * `CADRA_PROVIDER_KEY_ANTHROPIC` environment variable (see
 * `PROVIDER_KEY_ENV_VAR_PREFIX` below). If unset, the underlying
 * `@anthropic-ai/sdk` client itself falls back to reading
 * `process.env.ANTHROPIC_API_KEY` directly (that SDK's own documented
 * constructor default), so an operator relying on that variable already
 * being set in the server's process environment needs no Cadra-specific
 * configuration at all. Every other provider key (Veo, Runway, Kling, Luma,
 * Pika) remains Phase 34's job, unwired to any tool in this phase.
 */

/**
 * Provider API keys, keyed by an arbitrary provider identifier (e.g.
 * `"anthropic"`, `"veo"`, `"runway"`). Deliberately generic: this bag covers
 * both LLM providers (Phase 32's `"anthropic"`) and generative-video
 * providers (Phase 34's, still unwired), so it accepts any string key rather
 * than a closed union.
 */
export type ProviderKeys = Record<string, string>;

/** Fully-resolved Cadra MCP server configuration. */
export interface CadraMcpServerConfig {
  /** Absolute path to the root directory an agent's Cadra project files live under. */
  workspaceRoot: string;
  /** Absolute path to the directory rendered output (video, frames, logs) should be written to. */
  outputDirectory: string;
  /** Generative-video provider API keys, if any are configured. Empty object when none are set. */
  providerKeys: ProviderKeys;
}

/** Partial configuration accepted by {@link resolveCadraMcpServerConfig}; every field is optional and falls back to an environment variable, then a default. */
export type CadraMcpServerConfigInput = Partial<CadraMcpServerConfig>;

/** Environment variable read for {@link CadraMcpServerConfig.workspaceRoot} when no explicit option is passed. */
export const WORKSPACE_ROOT_ENV_VAR = "CADRA_WORKSPACE_ROOT";

/** Environment variable read for {@link CadraMcpServerConfig.outputDirectory} when no explicit option is passed. */
export const OUTPUT_DIRECTORY_ENV_VAR = "CADRA_OUTPUT_DIRECTORY";

/**
 * Environment variable prefix scanned for {@link CadraMcpServerConfig.providerKeys}
 * entries when no explicit option is passed: `CADRA_PROVIDER_KEY_ANTHROPIC=...`
 * becomes `providerKeys.anthropic` (read by `generate_scene_from_text`; see
 * this module's own doc), `CADRA_PROVIDER_KEY_VEO=...` becomes
 * `providerKeys.veo`, `CADRA_PROVIDER_KEY_RUNWAY=...` becomes
 * `providerKeys.runway`, and so on. The provider identifier is lowercased
 * from the remainder of the variable name.
 */
export const PROVIDER_KEY_ENV_VAR_PREFIX = "CADRA_PROVIDER_KEY_";

/** Default {@link CadraMcpServerConfig.workspaceRoot} used when neither an explicit option nor the environment variable is set: the process' current working directory. */
function defaultWorkspaceRoot(env: NodeJS.ProcessEnv): string {
  return env[WORKSPACE_ROOT_ENV_VAR] ?? process.cwd();
}

/** Default {@link CadraMcpServerConfig.outputDirectory} used when neither an explicit option nor the environment variable is set: `<workspaceRoot>/.cadra/output`. */
function defaultOutputDirectory(env: NodeJS.ProcessEnv, workspaceRoot: string): string {
  const fromEnv = env[OUTPUT_DIRECTORY_ENV_VAR];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  return `${workspaceRoot}/.cadra/output`;
}

/**
 * Scans `env` for `CADRA_PROVIDER_KEY_<NAME>` variables and returns them as a
 * `{ <name lowercased>: <value> }` bag. Returns an empty object when none are
 * set, never `undefined`, so callers can always spread/iterate the result
 * without a null check.
 */
function providerKeysFromEnv(env: NodeJS.ProcessEnv): ProviderKeys {
  const keys: ProviderKeys = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PROVIDER_KEY_ENV_VAR_PREFIX) || value === undefined) {
      continue;
    }
    const providerId = name.slice(PROVIDER_KEY_ENV_VAR_PREFIX.length).toLowerCase();
    if (providerId.length === 0) {
      continue;
    }
    keys[providerId] = value;
  }
  return keys;
}

/**
 * Resolves a full {@link CadraMcpServerConfig} from an optional partial input
 * object, falling back to environment variables, then to defaults, for any
 * field the input omits.
 *
 * Precedence per field: explicit `input` value, then the matching
 * environment variable, then a hardcoded default. `input.providerKeys` (if
 * given) replaces environment-derived provider keys entirely rather than
 * merging with them, so a caller that wants to combine both is expected to
 * do so before calling this function.
 *
 * `env` defaults to `process.env` and is only a parameter to keep this
 * function pure/testable; production callers should omit it.
 */
export function resolveCadraMcpServerConfig(
  input: CadraMcpServerConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): CadraMcpServerConfig {
  const workspaceRoot = input.workspaceRoot ?? defaultWorkspaceRoot(env);
  const outputDirectory = input.outputDirectory ?? defaultOutputDirectory(env, workspaceRoot);
  const providerKeys = input.providerKeys ?? providerKeysFromEnv(env);

  return {
    workspaceRoot,
    outputDirectory,
    providerKeys,
  };
}
