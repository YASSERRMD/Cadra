import { parseScene } from "@cadra/schema";
import { describe, expect, it } from "vitest";

import { SceneBuildError } from "./errors.js";
import { Shape, Text } from "./primitives.js";
import { scene } from "./scene-builder.js";

describe("scene().build()", () => {
  it("produces a document that already passes parseScene", () => {
    const document = scene({ id: "p1", name: "Project 1" })
      .composition({
        id: "c1",
        name: "Main",
        fps: 30,
        durationInFrames: 30,
        width: 640,
        height: 360,
      })
      .add(Shape({ id: "s1" }).at(0, 30))
      .build();

    expect(parseScene(document).success).toBe(true);
  });

  it("stamps the current schema version onto the document", () => {
    const document = scene({ id: "p1", name: "Project 1" })
      .composition({
        id: "c1",
        name: "Main",
        fps: 30,
        durationInFrames: 30,
        width: 640,
        height: 360,
      })
      .build();

    expect(document.schemaVersion).toBe(1);
  });

  it("includes every composition added via multiple .composition() calls", () => {
    const builder = scene({ id: "p1", name: "Project 1" });
    builder.composition({
      id: "c1",
      name: "First",
      fps: 30,
      durationInFrames: 30,
      width: 640,
      height: 360,
    });
    builder.composition({
      id: "c2",
      name: "Second",
      fps: 24,
      durationInFrames: 24,
      width: 800,
      height: 600,
    });

    const document = builder.build();
    expect(document.project.compositions.map((composition) => composition.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("is chainable start to finish: scene().composition().add().build()", () => {
    const document = scene({ id: "p1", name: "Project 1" })
      .composition({
        id: "c1",
        name: "Main",
        fps: 30,
        durationInFrames: 60,
        width: 1280,
        height: 720,
      })
      .add(Text({ id: "t1", content: "Hi" }).at(0, 60))
      .build();

    expect(document.project.compositions[0]?.tracks[0]?.clips[0]?.node.id).toBe("t1");
  });

  it("build() called from a CompositionBuilder assembles every composition, not just its own", () => {
    const builder = scene({ id: "p1", name: "Project 1" });
    builder.composition({
      id: "c1",
      name: "First",
      fps: 30,
      durationInFrames: 30,
      width: 640,
      height: 360,
    });
    const secondComposition = builder.composition({
      id: "c2",
      name: "Second",
      fps: 30,
      durationInFrames: 30,
      width: 640,
      height: 360,
    });

    const document = secondComposition.build();
    expect(document.project.compositions.map((composition) => composition.id)).toEqual([
      "c1",
      "c2",
    ]);
  });
});

describe("scene().build(): SceneBuildError on a deliberately impossible build", () => {
  it("throws SceneBuildError (not a generic Error/string) for an invalid document", () => {
    // Bypasses .at()'s own guard by handing a raw, malformed Clip straight to
    // .add(), so the invalidity is only caught by parseScene inside .build().
    let thrown: unknown;
    try {
      scene({ id: "p1", name: "Project 1" })
        .composition({
          id: "c1",
          name: "Main",
          fps: 30,
          durationInFrames: 30,
          width: 640,
          height: 360,
        })
        .add({
          id: "bad-clip",
          startFrame: -1,
          durationInFrames: 10,
          node: Shape({ id: "s1" }).node,
        })
        .build();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SceneBuildError);
  });

  it("carries the exact SceneParseDiagnostic[] parseScene reported, naming the offending field", () => {
    let thrown: SceneBuildError | undefined;
    try {
      scene({ id: "p1", name: "Project 1" })
        .composition({
          id: "c1",
          name: "Main",
          fps: 30,
          durationInFrames: 30,
          width: 640,
          height: 360,
        })
        .add({
          id: "bad-clip",
          startFrame: -1,
          durationInFrames: 10,
          node: Shape({ id: "s1" }).node,
        })
        .build();
    } catch (error) {
      thrown = error as SceneBuildError;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.diagnostics.length).toBeGreaterThan(0);
    const diagnostic = thrown?.diagnostics.find((candidate) =>
      candidate.path.includes("startFrame"),
    );
    expect(diagnostic).toBeDefined();
  });

  it("error.message names every offending field, not just a generic string", () => {
    let thrown: SceneBuildError | undefined;
    try {
      scene({ id: "p1", name: "Project 1" })
        .composition({
          id: "c1",
          name: "Main",
          fps: 30,
          durationInFrames: 30,
          width: 640,
          height: 360,
        })
        .add({
          id: "bad-clip",
          startFrame: -1,
          durationInFrames: 10,
          node: Shape({ id: "s1" }).node,
        })
        .build();
    } catch (error) {
      thrown = error as SceneBuildError;
    }

    expect(thrown?.message).toContain("startFrame");
  });
});
