import { describe, expect, it } from "vitest";

import { APP_NAME, VERSION } from "./main.js";

describe("cli placeholder", () => {
  it("exports the expected VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the expected APP_NAME", () => {
    expect(APP_NAME).toBe("cli");
  });
});
