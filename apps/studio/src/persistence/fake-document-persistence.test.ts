import { describe, expect, it } from "vitest";

import { createFakeDocumentPersistence } from "./fake-document-persistence.js";

describe("createFakeDocumentPersistence", () => {
  it("open() resolves undefined when no file was queued (cancelled picker)", async () => {
    const persistence = createFakeDocumentPersistence();
    persistence.queueOpen(undefined);

    await expect(persistence.open()).resolves.toBeUndefined();
  });

  it("open() resolves the seeded file's contents, name, and a handle", async () => {
    const persistence = createFakeDocumentPersistence();
    persistence.seedFile("scene.cadra.json", '{"hello":"world"}');
    persistence.queueOpen("scene.cadra.json");

    const result = await persistence.open();

    expect(result).toBeDefined();
    expect(result?.contents).toBe('{"hello":"world"}');
    expect(result?.name).toBe("scene.cadra.json");
    expect(result?.handle).toBeDefined();
  });

  it("open() throws if a name is queued that was never seeded", async () => {
    const persistence = createFakeDocumentPersistence();
    persistence.queueOpen("missing.cadra.json");

    await expect(persistence.open()).rejects.toThrow(/no file seeded/);
  });

  it("save() with no handle records a save under the default untitled name", async () => {
    const persistence = createFakeDocumentPersistence();

    const result = await persistence.save('{"a":1}', undefined);

    expect(result).toBeDefined();
    expect(persistence.savedFiles).toEqual([{ name: result?.name, contents: '{"a":1}' }]);
  });

  it("save() with a handle from a prior open() writes back to that same name", async () => {
    const persistence = createFakeDocumentPersistence();
    persistence.seedFile("scene.cadra.json", '{"version":1}');
    persistence.queueOpen("scene.cadra.json");
    const opened = await persistence.open();

    await persistence.save('{"version":2}', opened?.handle);

    expect(persistence.savedFiles).toEqual([
      { name: "scene.cadra.json", contents: '{"version":2}' },
    ]);
  });

  it("a subsequent open() of the same name sees the latest saved contents", async () => {
    const persistence = createFakeDocumentPersistence();
    persistence.seedFile("scene.cadra.json", '{"version":1}');
    persistence.queueOpen("scene.cadra.json");
    const opened = await persistence.open();
    await persistence.save('{"version":2}', opened?.handle);

    persistence.queueOpen("scene.cadra.json");
    const reopened = await persistence.open();

    expect(reopened?.contents).toBe('{"version":2}');
  });
});
