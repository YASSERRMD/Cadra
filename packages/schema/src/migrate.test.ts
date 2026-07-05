import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION } from "./envelope.js";
import { migrateSceneDocument } from "./migrate.js";

describe("migrateSceneDocument", () => {
  it("returns the document unchanged when fromVersion is the current version", () => {
    const document = { schemaVersion: CURRENT_SCHEMA_VERSION, project: { id: "p1" } };

    const result = migrateSceneDocument(document, CURRENT_SCHEMA_VERSION);

    expect(result).toBe(document);
  });

  it("throws when fromVersion is newer than the current supported version", () => {
    const document = { schemaVersion: CURRENT_SCHEMA_VERSION + 1, project: {} };

    expect(() => migrateSceneDocument(document, CURRENT_SCHEMA_VERSION + 1)).toThrow(
      /newer than the current supported version/,
    );
  });

  it("throws when stepping forward from an older version with no registered migration", () => {
    const document = { schemaVersion: 0, project: {} };

    // There is only one schema version so far, so version 0 (or any version
    // below current) has no registered migration to step forward with.
    expect(() => migrateSceneDocument(document, 0)).toThrow(/No migration registered/);
  });
});
