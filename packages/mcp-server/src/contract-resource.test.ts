import { describe, expect, it } from "vitest";

import { CADRA_CONTRACT_RESOURCE_NAME, CADRA_CONTRACT_RESOURCE_URI } from "./contract-resource.js";

/**
 * The actual read behavior of `registerCadraContractResource` (that it
 * returns `describeCadraContract()`'s exact JSON output) is exercised
 * end-to-end via a real MCP `resources/read` call in `./stdio.test.ts` and
 * `./http.test.ts`, over both transports this package supports. Faking the
 * SDK's internal `RequestHandlerExtra` (abort signal, request id,
 * notification/request senders, and more) just to call the read callback
 * directly here would be more brittle than valuable; this file only locks
 * down the resource's identifying constants.
 */
describe("Cadra contract resource identifiers", () => {
  it("uses the cadra://contract URI scheme", () => {
    expect(CADRA_CONTRACT_RESOURCE_URI).toBe("cadra://contract");
  });

  it("has a stable resource name", () => {
    expect(CADRA_CONTRACT_RESOURCE_NAME).toBe("cadra-contract");
  });
});
