import { describe, expect, it } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  describeCadraContract,
  generateCapabilityManifest,
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

  it("exposes describeCadraContract and generateCapabilityManifest from the same barrel", () => {
    // The headline Phase 27 acceptance criterion: an agent can retrieve the
    // full contract at runtime with nothing more than this package's public
    // barrel, no reach-in to a specific submodule required.
    const contract = describeCadraContract();
    expect(contract.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(contract.examples.length).toBeGreaterThan(0);

    const manifest = generateCapabilityManifest();
    expect(manifest.primitives.length).toBeGreaterThan(0);
    expect(manifest.easings.length).toBeGreaterThan(0);
  });
});
