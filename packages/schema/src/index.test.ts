import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  PACKAGE_NAME,
  parseScene,
  sceneDocumentSchema,
  VERSION,
} from "./index.js";

describe("@cadra/schema package identity", () => {
  it("exports the expected VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the expected PACKAGE_NAME", () => {
    expect(PACKAGE_NAME).toBe("@cadra/schema");
  });
});

describe("@cadra/schema public surface", () => {
  it("exposes the current schema version as a positive integer", () => {
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  it("exposes a usable sceneDocumentSchema and parseScene from the same barrel", () => {
    const document = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: { id: "p1", name: "Project", compositions: [] },
    };

    expect(sceneDocumentSchema.safeParse(document).success).toBe(true);

    const result = parseScene(document);
    expect(result.success).toBe(true);
  });
});
