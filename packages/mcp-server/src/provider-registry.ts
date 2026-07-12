/**
 * Builds the `@cadra/providers` `ProviderRegistry` this server's shared
 * `GenerationStore` submits/polls generations against, from this server's
 * own resolved `providerKeys` config bag (`./config.ts`).
 *
 * Every one of `@cadra/providers`' five vendor adapters (veo/runway/kling/
 * luma/pika) has been fully implemented since that package's own Phase 34,
 * but `createCadraMcpServer` never called any of their `create*Provider`
 * factories - it always constructed the shared `GenerationStore` with
 * `providers: {}`, so `add_generated_clip` failed with `UnknownProviderError`
 * for every real vendor, regardless of whether an operator had set the
 * matching `CADRA_PROVIDER_KEY_*` environment variable. This module is that
 * missing wiring: a provider is registered if and only if its required
 * key(s) are present in `providerKeys`, so an unconfigured vendor still
 * fails the same descriptive `UnknownProviderError` it always did (never a
 * confusing crash from a half-constructed adapter with an empty API key).
 */
import {
  createKlingProvider,
  createLumaProvider,
  createPikaProvider,
  createRunwayProvider,
  createVeoProvider,
  type ProviderRegistry,
} from "@cadra/providers";

import type { ProviderKeys } from "./config.js";

/**
 * Builds a `ProviderRegistry` from `providerKeys`, registering each of the
 * five vendor adapters only when its required key(s) are present:
 *
 * - `veo`, `runway`, `luma`, `pika`: a single `providerKeys.<name>` API key,
 *   matching `CADRA_PROVIDER_KEY_<NAME>` (e.g. `CADRA_PROVIDER_KEY_VEO`).
 * - `kling`: Kling's adapter needs a separate Access Key and Secret Key
 *   (`KlingProviderOptions.accessKey`/`.secretKey`, its AK/SK JWT auth
 *   scheme - see `@cadra/providers`' own doc), so it reads two keys,
 *   `providerKeys.kling_access` and `providerKeys.kling_secret`
 *   (`CADRA_PROVIDER_KEY_KLING_ACCESS`/`CADRA_PROVIDER_KEY_KLING_SECRET`),
 *   and is only registered when both are present.
 *
 * `providerKeys.anthropic` (the text-to-scene LLM key) is not a video
 * provider and is deliberately never read here; see `./text-to-scene-tools.ts`.
 */
export function buildVideoProviderRegistry(providerKeys: ProviderKeys): ProviderRegistry {
  const registry: ProviderRegistry = {};

  if (providerKeys.veo !== undefined) {
    registry.veo = createVeoProvider({ apiKey: providerKeys.veo });
  }
  if (providerKeys.runway !== undefined) {
    registry.runway = createRunwayProvider({ apiKey: providerKeys.runway });
  }
  if (providerKeys.luma !== undefined) {
    registry.luma = createLumaProvider({ apiKey: providerKeys.luma });
  }
  if (providerKeys.pika !== undefined) {
    registry.pika = createPikaProvider({ apiKey: providerKeys.pika });
  }
  if (providerKeys.kling_access !== undefined && providerKeys.kling_secret !== undefined) {
    registry.kling = createKlingProvider({
      accessKey: providerKeys.kling_access,
      secretKey: providerKeys.kling_secret,
    });
  }

  return registry;
}
