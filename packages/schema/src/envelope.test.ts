import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, sceneDocumentSchema } from "./envelope.js";

function minimalProject() {
  return { id: "p1", name: "Project", compositions: [] };
}

describe("CURRENT_SCHEMA_VERSION", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe("sceneDocumentSchema", () => {
  it("accepts a document with the current schemaVersion and a valid project", () => {
    const result = sceneDocumentSchema.safeParse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: minimalProject(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a document with a schemaVersion other than the current one", () => {
    const result = sceneDocumentSchema.safeParse({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      project: minimalProject(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a document with schemaVersion inside the project object", () => {
    const result = sceneDocumentSchema.safeParse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      project: { ...minimalProject(), schemaVersion: CURRENT_SCHEMA_VERSION },
    });
    // The extra `schemaVersion` key on `project` is not part of `Project`'s
    // shape, so a strict object schema rejects it as an unrecognized key.
    expect(result.success).toBe(false);
  });

  it("rejects a document missing the project field entirely", () => {
    const result = sceneDocumentSchema.safeParse({ schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(result.success).toBe(false);
  });
});
