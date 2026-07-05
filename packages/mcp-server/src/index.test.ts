import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, VERSION } from "./index.js";

describe("@cadra/mcp-server placeholder", () => {
  it("exports the expected VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the expected PACKAGE_NAME", () => {
    expect(PACKAGE_NAME).toBe("@cadra/mcp-server");
  });
});
