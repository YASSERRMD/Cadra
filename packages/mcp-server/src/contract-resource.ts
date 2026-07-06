/**
 * Exposes Phase 27's `describeCadraContract()` (the full, versioned Cadra
 * scene contract: JSON Schema, capability manifest, and curated examples) as
 * a single MCP resource, so any MCP-capable agent can learn the entire
 * Cadra scene format at runtime with one `resources/read` call, with no
 * other lookup and no dependency on this package's own source.
 */
import { describeCadraContract } from "@cadra/schema";
import type { McpServer, RegisteredResource } from "@modelcontextprotocol/sdk/server/mcp.js";

/** The fixed URI clients read to fetch the Cadra contract; stable across server restarts and unaffected by configuration. */
export const CADRA_CONTRACT_RESOURCE_URI = "cadra://contract";

/** Registered resource name, surfaced to clients alongside the URI in `resources/list`. */
export const CADRA_CONTRACT_RESOURCE_NAME = "cadra-contract";

/** MIME type the contract resource is served as: it is `describeCadraContract()`'s JSON output, serialized. */
const CONTRACT_MIME_TYPE = "application/json";

/**
 * Registers the `cadra://contract` resource on `server`. Every read calls
 * `describeCadraContract()` fresh (nothing is cached at registration time),
 * matching that function's own freshness guarantee: a client can never
 * observe a stale contract from an older `@cadra/schema` build than the one
 * this server process actually has loaded.
 */
export function registerCadraContractResource(server: McpServer): RegisteredResource {
  return server.registerResource(
    CADRA_CONTRACT_RESOURCE_NAME,
    CADRA_CONTRACT_RESOURCE_URI,
    {
      title: "Cadra scene contract",
      description:
        "The full Cadra scene contract: JSON Schema, capability manifest (primitives, properties, easings, codecs), and curated example scene documents. Generated fresh from @cadra/schema on every read.",
      mimeType: CONTRACT_MIME_TYPE,
    },
    (uri) => {
      const contract = describeCadraContract();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: CONTRACT_MIME_TYPE,
            text: JSON.stringify(contract),
          },
        ],
      };
    },
  );
}
