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

/** A structurally valid document with one composition, one track, and one clip whose root node has id `"node-alt"` (for `selectedNodeId` survival tests). */
function buildDocumentWithNode(): unknown {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: "project-node",
      name: "Project With Node",
      compositions: [
        {
          id: "comp-node",
          name: "Composition With Node",
          fps: 30,
          durationInFrames: 90,
          width: 1920,
          height: 1080,
          tracks: [
            {
              id: "track-1",
              clips: [
                {
                  id: "clip-1",
                  startFrame: 0,
                  durationInFrames: 90,
                  node: {
                    id: "node-alt",
                    kind: "group",
                    transform: {
                      position: [0, 0, 0],
                      rotation: [0, 0, 0],
                      scale: [1, 1, 1],
                    },
                    visible: true,
                    children: [],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** A third structurally valid document, distinct from both the store's fresh default and `buildAlternateValidDocument`, for multi-step undo/redo tests. */
function buildThirdValidDocument(): unknown {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: {
      id: "project-third",
      name: "Third Project",
      compositions: [
        {
          id: "comp-third",
          name: "Third Composition",
          fps: 60,
          durationInFrames: 120,
          width: 3840,
          height: 2160,
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

  describe("selectNode / selectedNodeId (Phase 39's prerequisite selection mechanism)", () => {
    it("starts with no node selected", () => {
      expect(store.getState().selectedNodeId).toBeUndefined();
    });

    it("selectNode sets selectedNodeId", () => {
      store.getState().selectNode("some-node-id");

      expect(store.getState().selectedNodeId).toBe("some-node-id");
    });

    it("selectNode(undefined) clears the selection", () => {
      store.getState().selectNode("some-node-id");

      store.getState().selectNode(undefined);

      expect(store.getState().selectedNodeId).toBeUndefined();
    });

    it("a selected node survives an unrelated commit that still contains it", () => {
      store.getState().commitDocument(buildDocumentWithNode());
      store.getState().selectNode("node-alt");

      // A second, unrelated valid commit (the same document, re-committed)
      // must not clear a selection that is still present in the result.
      store.getState().commitDocument(buildDocumentWithNode());

      expect(store.getState().selectedNodeId).toBe("node-alt");
    });

    it("a selected node is cleared once a newly committed document no longer contains it", () => {
      store.getState().commitDocument(buildDocumentWithNode());
      store.getState().selectNode("node-alt");

      store.getState().commitDocument(buildAlternateValidDocument());

      expect(store.getState().selectedNodeId).toBeUndefined();
    });

    it("a selected node is cleared by newDocument (a fresh document never contains a prior selection)", () => {
      store.getState().commitDocument(buildDocumentWithNode());
      store.getState().selectNode("node-alt");

      store.getState().newDocument();

      expect(store.getState().selectedNodeId).toBeUndefined();
    });

    it("undo re-populates selectedNodeId when the restored document contains the currently selected node", () => {
      // selectedNodeId is not itself part of the undo history (only
      // document/historyIndex are); undo/applyDocument simply re-validates
      // whatever selectedNodeId is current against the document undo is
      // restoring, exactly like commitDocument already does for a fresh
      // commit. Selecting "node-alt" only after the commit that removes it
      // from history (rather than before, per this suite's other cases)
      // proves that: the restored document still contains "node-alt" (it
      // was never removed from the document itself, only from history via
      // the later commit this test undoes), so undo keeps the selection
      // rather than clearing it.
      store.getState().commitDocument(buildDocumentWithNode());
      store.getState().commitDocument(buildAlternateValidDocument());
      store.getState().selectNode("node-alt");

      store.getState().undo();

      expect(store.getState().document).toEqual(buildDocumentWithNode());
      expect(store.getState().selectedNodeId).toBe("node-alt");
    });

    it("undo clears selectedNodeId when the restored document does not contain the currently selected node", () => {
      store.getState().commitDocument(buildAlternateValidDocument());
      store.getState().commitDocument(buildDocumentWithNode());
      store.getState().selectNode("node-alt");

      store.getState().undo();

      expect(store.getState().document).toEqual(buildAlternateValidDocument());
      expect(store.getState().selectedNodeId).toBeUndefined();
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

  describe("undo/redo (Task 5: undo history)", () => {
    it("starts with a single history entry (the initial document) and historyIndex 0", () => {
      const state = store.getState();
      expect(state.history).toHaveLength(1);
      expect(state.history[0]).toEqual(state.document);
      expect(state.historyIndex).toBe(0);
    });

    it("undo is a no-op when there is nothing to undo yet", () => {
      const before = store.getState().document;

      store.getState().undo();

      expect(store.getState().document).toBe(before);
      expect(store.getState().historyIndex).toBe(0);
    });

    it("redo is a no-op when there is nothing to redo yet", () => {
      const before = store.getState().document;

      store.getState().redo();

      expect(store.getState().document).toBe(before);
    });

    it("a successful commitDocument appends to history and advances historyIndex", () => {
      const initial = store.getState().document;
      const candidate = buildAlternateValidDocument();

      store.getState().commitDocument(candidate);

      const state = store.getState();
      expect(state.history).toEqual([initial, candidate]);
      expect(state.historyIndex).toBe(1);
    });

    it("undo after a commit restores the previous document", () => {
      const initial = store.getState().document;
      store.getState().commitDocument(buildAlternateValidDocument());

      store.getState().undo();

      expect(store.getState().document).toEqual(initial);
      expect(store.getState().historyIndex).toBe(0);
    });

    it("redo after an undo restores the document that was undone", () => {
      const alternate = buildAlternateValidDocument();
      store.getState().commitDocument(alternate);
      store.getState().undo();

      store.getState().redo();

      expect(store.getState().document).toEqual(alternate);
      expect(store.getState().historyIndex).toBe(1);
    });

    it("undo does not remove the entry from history (it can be redone again)", () => {
      const alternate = buildAlternateValidDocument();
      store.getState().commitDocument(alternate);

      store.getState().undo();

      expect(store.getState().history).toHaveLength(2);
    });

    it("supports multiple sequential undos back through several commits", () => {
      const initial = store.getState().document;
      const alternate = buildAlternateValidDocument();
      const third = buildThirdValidDocument();
      store.getState().commitDocument(alternate);
      store.getState().commitDocument(third);

      store.getState().undo();
      expect(store.getState().document).toEqual(alternate);

      store.getState().undo();
      expect(store.getState().document).toEqual(initial);

      // Fully exhausted: a further undo is a no-op.
      store.getState().undo();
      expect(store.getState().document).toEqual(initial);
      expect(store.getState().historyIndex).toBe(0);
    });

    it("supports multiple sequential redos back up through several commits", () => {
      const alternate = buildAlternateValidDocument();
      const third = buildThirdValidDocument();
      store.getState().commitDocument(alternate);
      store.getState().commitDocument(third);
      store.getState().undo();
      store.getState().undo();

      store.getState().redo();
      expect(store.getState().document).toEqual(alternate);

      store.getState().redo();
      expect(store.getState().document).toEqual(third);

      // Fully exhausted: a further redo is a no-op.
      store.getState().redo();
      expect(store.getState().document).toEqual(third);
    });

    it("a new commit after an undo truncates the redo stack (the conventional 'new edit clears redo' behavior)", () => {
      const initial = store.getState().document;
      const alternate = buildAlternateValidDocument();
      const third = buildThirdValidDocument();
      store.getState().commitDocument(alternate);
      store.getState().undo(); // back to initial; "alternate" is now a pending redo

      store.getState().commitDocument(third); // a fresh edit from here

      const state = store.getState();
      expect(state.history).toEqual([initial, third]);
      expect(state.historyIndex).toBe(1);
      // The truncated "alternate" entry is gone: redo has nothing to reach it with.
      store.getState().redo();
      expect(store.getState().document).toEqual(third);
    });

    it("a rejected commitDocument does not touch history", () => {
      const historyBefore = store.getState().history;
      const invalidCandidate = { schemaVersion: CURRENT_SCHEMA_VERSION, project: { id: "no-name" } };

      store.getState().commitDocument(invalidCandidate);

      expect(store.getState().history).toBe(historyBefore);
      expect(store.getState().historyIndex).toBe(0);
    });

    it("newDocument (which funnels through commitDocument) is itself undoable", () => {
      store.getState().commitDocument(buildAlternateValidDocument());
      store.getState().newDocument();
      expect(store.getState().history).toHaveLength(3); // initial, alternate, fresh

      store.getState().undo();

      expect(store.getState().document).toEqual(buildAlternateValidDocument());
    });

    it("undo re-selects the first composition when the restored document no longer has the currently selected one", () => {
      store.getState().commitDocument(buildAlternateValidDocument());
      expect(store.getState().selectedCompositionId).toBe("comp-alt");

      store.getState().undo();

      // Back to the initial document, whose only composition is not "comp-alt".
      expect(store.getState().selectedCompositionId).not.toBe("comp-alt");
      expect(store.getState().selectedCompositionId).toBe(
        store.getState().document.project.compositions[0]?.id,
      );
    });

    it("every document undo/redo lands on still passes parseScene", () => {
      const alternate = buildAlternateValidDocument();
      const third = buildThirdValidDocument();
      store.getState().commitDocument(alternate);
      store.getState().commitDocument(third);

      store.getState().undo();
      expect(parseScene(store.getState().document).success).toBe(true);
      store.getState().undo();
      expect(parseScene(store.getState().document).success).toBe(true);
      store.getState().redo();
      expect(parseScene(store.getState().document).success).toBe(true);
      store.getState().redo();
      expect(parseScene(store.getState().document).success).toBe(true);
    });
  });
});
