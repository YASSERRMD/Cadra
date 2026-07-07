import { CURRENT_SCHEMA_VERSION, parseScene } from "@cadra/schema";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createFakeDocumentPersistence,
  type FakeDocumentPersistence,
} from "../persistence/fake-document-persistence.js";
import { createDocumentStore } from "./document-store.js";

/** A structurally valid SceneDocument distinct from the store's own fresh-document defaults, for round-trip/edit tests. */
function buildAlternateValidDocument(): unknown {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: "project-alt",
      name: "Alternate Project",
      compositions: [
        {
          id: "comp-alt",
          name: "Alternate Composition",
          fps: 24,
          durationInFrames: 48,
          width: 1280,
          height: 720,
          tracks: [],
        },
      ],
    },
  };
}

describe("createDocumentStore", () => {
  let persistence: FakeDocumentPersistence;
  let store: ReturnType<typeof createDocumentStore>;

  beforeEach(() => {
    persistence = createFakeDocumentPersistence();
    store = createDocumentStore(persistence);
  });

  describe("initial state", () => {
    it("starts with a fresh document that itself passes parseScene", () => {
      const { document } = store.getState();
      expect(parseScene(document).success).toBe(true);
    });

    it("starts with exactly one composition selected", () => {
      const { document, selectedCompositionId } = store.getState();
      expect(document.project.compositions).toHaveLength(1);
      expect(selectedCompositionId).toBe(document.project.compositions[0]?.id);
    });

    it("starts with no validation or persistence error", () => {
      const state = store.getState();
      expect(state.lastValidationError).toBeUndefined();
      expect(state.lastPersistenceError).toBeUndefined();
    });
  });

  describe("commitDocument (Task 5: validate every store edit)", () => {
    it("accepts a valid candidate and replaces document", () => {
      const candidate = buildAlternateValidDocument();

      const committed = store.getState().commitDocument(candidate);

      expect(committed).toBe(true);
      expect(store.getState().document).toEqual(candidate);
      expect(store.getState().lastValidationError).toBeUndefined();
    });

    it("rejects an invalid candidate, keeping the last-known-valid document", () => {
      const originalDocument = store.getState().document;
      const invalidCandidate = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        project: { id: "no-name" },
      };

      const committed = store.getState().commitDocument(invalidCandidate);

      expect(committed).toBe(false);
      expect(store.getState().document).toBe(originalDocument);
    });

    it("exposes diagnostics for a rejected edit", () => {
      const invalidCandidate = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        project: { id: "no-name" },
      };

      store.getState().commitDocument(invalidCandidate);

      const { lastValidationError } = store.getState();
      expect(lastValidationError).toBeDefined();
      expect(lastValidationError?.length).toBeGreaterThan(0);
    });

    it("clears a previous validation error once a subsequent edit succeeds", () => {
      store.getState().commitDocument({ schemaVersion: CURRENT_SCHEMA_VERSION, project: {} });
      expect(store.getState().lastValidationError).toBeDefined();

      store.getState().commitDocument(buildAlternateValidDocument());

      expect(store.getState().lastValidationError).toBeUndefined();
    });

    it("re-selects the first composition when the currently selected one no longer exists", () => {
      const candidate = buildAlternateValidDocument();

      store.getState().commitDocument(candidate);

      expect(store.getState().selectedCompositionId).toBe("comp-alt");
    });

    it("never leaves the store holding a document that fails parseScene, across a mix of valid and invalid commits", () => {
      const attempts: unknown[] = [
        buildAlternateValidDocument(),
        { schemaVersion: CURRENT_SCHEMA_VERSION, project: { id: 5 } },
        { notEvenACadraDocument: true },
        buildAlternateValidDocument(),
      ];

      for (const attempt of attempts) {
        store.getState().commitDocument(attempt);
        expect(parseScene(store.getState().document).success).toBe(true);
      }
    });
  });

  describe("selectComposition", () => {
    it("switches to an existing composition id", () => {
      store.getState().commitDocument(buildAlternateValidDocument());

      store.getState().selectComposition("comp-alt");

      expect(store.getState().selectedCompositionId).toBe("comp-alt");
    });

    it("is a no-op for an id not present in the current document", () => {
      const before = store.getState().selectedCompositionId;

      store.getState().selectComposition("does-not-exist");

      expect(store.getState().selectedCompositionId).toBe(before);
    });
  });

  describe("newDocument", () => {
    it("resets to a small valid document and clears provenance", () => {
      store.getState().commitDocument(buildAlternateValidDocument());

      store.getState().newDocument();

      const state = store.getState();
      expect(parseScene(state.document).success).toBe(true);
      expect(state.document.project.compositions).toHaveLength(1);
      expect(state.provenance).toEqual({ name: "Untitled", handle: undefined });
    });
  });

  describe("openDocument / saveDocument round trips (Task 6)", () => {
    it("open() with a cancelled picker leaves the document untouched", async () => {
      const before = store.getState().document;
      persistence.queueOpen(undefined);

      await store.getState().openDocument();

      expect(store.getState().document).toBe(before);
    });

    it("open() loads a previously saved valid document and updates provenance", async () => {
      const alternate = buildAlternateValidDocument();
      persistence.seedFile("scene.cadra.json", JSON.stringify(alternate));
      persistence.queueOpen("scene.cadra.json");

      await store.getState().openDocument();

      const state = store.getState();
      expect(state.document).toEqual(alternate);
      expect(state.provenance.name).toBe("scene.cadra.json");
      expect(state.lastPersistenceError).toBeUndefined();
    });

    it("open() of a file that is not valid JSON sets lastPersistenceError and does not commit", async () => {
      const before = store.getState().document;
      persistence.seedFile("broken.cadra.json", "{ not json");
      persistence.queueOpen("broken.cadra.json");

      await store.getState().openDocument();

      expect(store.getState().document).toBe(before);
      expect(store.getState().lastPersistenceError).toMatch(/not valid JSON/);
    });

    it("open() of well-formed JSON that fails schema validation does not commit, and surfaces both errors", async () => {
      const before = store.getState().document;
      const invalidDoc = { schemaVersion: CURRENT_SCHEMA_VERSION, project: { id: "missing-name" } };
      persistence.seedFile("invalid.cadra.json", JSON.stringify(invalidDoc));
      persistence.queueOpen("invalid.cadra.json");

      await store.getState().openDocument();

      expect(store.getState().document).toBe(before);
      expect(store.getState().lastPersistenceError).toBeDefined();
      expect(store.getState().lastValidationError).toBeDefined();
    });

    it("save() with a cancelled save-location prompt leaves provenance untouched", async () => {
      const beforeProvenance = store.getState().provenance;
      // The fake's save() never itself resolves undefined by default; simulate
      // a cancelled prompt by having the fake persistence's save reject
      // nothing and instead directly assert the "no-op on undefined" path
      // using a persistence stub for this one test.
      const cancelingPersistence = createFakeDocumentPersistence();
      cancelingPersistence.save = async () => undefined;
      const cancelingStore = createDocumentStore(cancelingPersistence);

      await cancelingStore.getState().saveDocument();

      expect(cancelingStore.getState().provenance).toEqual(beforeProvenance);
    });

    it("load then save round-trips the document byte-for-byte (deep-equal) identical", async () => {
      const original = buildAlternateValidDocument();
      persistence.seedFile("roundtrip.cadra.json", JSON.stringify(original));
      persistence.queueOpen("roundtrip.cadra.json");
      await store.getState().openDocument();

      await store.getState().saveDocument();

      expect(persistence.savedFiles).toHaveLength(1);
      const savedContents = persistence.savedFiles[0]?.contents;
      expect(savedContents).toBeDefined();
      expect(JSON.parse(savedContents as string)).toEqual(original);
    });

    it("save() reuses the handle from the prior open(), writing back to the same name", async () => {
      const original = buildAlternateValidDocument();
      persistence.seedFile("named.cadra.json", JSON.stringify(original));
      persistence.queueOpen("named.cadra.json");
      await store.getState().openDocument();

      await store.getState().saveDocument();

      expect(persistence.savedFiles[0]?.name).toBe("named.cadra.json");
      expect(store.getState().provenance.name).toBe("named.cadra.json");
    });

    it("editing after load then saving persists the edit", async () => {
      const original = buildAlternateValidDocument();
      persistence.seedFile("edit-me.cadra.json", JSON.stringify(original));
      persistence.queueOpen("edit-me.cadra.json");
      await store.getState().openDocument();

      const edited = {
        ...(store.getState().document as object),
        project: { ...store.getState().document.project, name: "Renamed Project" },
      };
      const committed = store.getState().commitDocument(edited);
      expect(committed).toBe(true);

      await store.getState().saveDocument();

      const savedContents = persistence.savedFiles[0]?.contents;
      expect(savedContents).toBeDefined();
      const savedParsed = JSON.parse(savedContents as string);
      expect(savedParsed.project.name).toBe("Renamed Project");
      // And the persisted edit is still itself a fully valid document.
      expect(parseScene(savedParsed).success).toBe(true);
    });

    it("saving a brand-new (never opened) document prompts for a location and records it", async () => {
      await store.getState().saveDocument();

      expect(persistence.savedFiles).toHaveLength(1);
      const savedParsed = JSON.parse(persistence.savedFiles[0]?.contents as string);
      expect(parseScene(savedParsed).success).toBe(true);
    });
  });
});
