import { describe, expect, it } from "vitest";

import {
  Camera,
  createTextToSceneAdapter,
  extractJsonFromLlmResponse,
  Image,
  Light,
  PACKAGE_NAME,
  scene,
  SceneBuildError,
  SceneBuilderUsageError,
  Sequence,
  Series,
  Shape,
  Text,
  VERSION,
} from "./index.js";

describe("@cadra/agent-sdk package identity", () => {
  it("exports the expected VERSION", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the expected PACKAGE_NAME", () => {
    expect(PACKAGE_NAME).toBe("@cadra/agent-sdk");
  });
});

describe("@cadra/agent-sdk barrel: every public entry point is reachable from the package root", () => {
  it("exports the scene() builder entry point and every Phase 7 primitive", () => {
    expect(typeof scene).toBe("function");
    expect(typeof Text).toBe("function");
    expect(typeof Image).toBe("function");
    expect(typeof Shape).toBe("function");
    expect(typeof Camera).toBe("function");
    expect(typeof Light).toBe("function");
    expect(typeof Sequence).toBe("function");
    expect(typeof Series).toBe("function");
  });

  it("exports both typed error classes", () => {
    expect(SceneBuildError).toBeInstanceOf(Function);
    expect(SceneBuilderUsageError).toBeInstanceOf(Function);
  });

  it("exports the Phase 32 text-to-scene entry points", () => {
    expect(typeof createTextToSceneAdapter).toBe("function");
    expect(typeof extractJsonFromLlmResponse).toBe("function");
  });

  it("builds a minimal document end to end using only barrel imports", () => {
    const document = scene({ id: "p", name: "P" })
      .composition({
        id: "c",
        name: "Main",
        fps: 30,
        durationInFrames: 30,
        width: 640,
        height: 360,
      })
      .add(Shape({ id: "s1" }).at(0, 30))
      .build();

    expect(document.schemaVersion).toBe(1);
    expect(document.project.id).toBe("p");
  });
});
