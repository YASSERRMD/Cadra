import { describe, expect, it } from "vitest";

import { SceneBuildError, SceneBuilderUsageError } from "./errors.js";

describe("SceneBuildError", () => {
  it("is an instance of Error and carries the exact diagnostics array passed in", () => {
    const diagnostics = [{ path: "project.compositions[0].fps", message: "expected int" }];
    const error = new SceneBuildError(diagnostics);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SceneBuildError);
    expect(error.name).toBe("SceneBuildError");
    expect(error.diagnostics).toBe(diagnostics);
  });

  it("formats a single diagnostic using the singular 'problem'", () => {
    const error = new SceneBuildError([{ path: "project.name", message: "Required" }]);
    expect(error.message).toContain("(1 problem)");
    expect(error.message).toContain("project.name: Required");
  });

  it("formats multiple diagnostics using the plural 'problems', one per line", () => {
    const error = new SceneBuildError([
      { path: "project.name", message: "Required" },
      { path: "project.compositions[0].fps", message: "Expected int" },
    ]);
    expect(error.message).toContain("(2 problems)");
    expect(error.message).toContain("project.name: Required");
    expect(error.message).toContain("project.compositions[0].fps: Expected int");
  });

  it("formats zero diagnostics gracefully (plural, empty body)", () => {
    const error = new SceneBuildError([]);
    expect(error.message).toContain("(0 problems)");
    expect(error.diagnostics).toEqual([]);
  });

  it("preserves diagnostic order in the formatted message", () => {
    const error = new SceneBuildError([
      { path: "a", message: "first" },
      { path: "b", message: "second" },
    ]);
    const indexOfA = error.message.indexOf("a: first");
    const indexOfB = error.message.indexOf("b: second");
    expect(indexOfA).toBeGreaterThanOrEqual(0);
    expect(indexOfB).toBeGreaterThan(indexOfA);
  });
});

describe("SceneBuilderUsageError", () => {
  it("is an instance of Error and preserves the given message", () => {
    const error = new SceneBuilderUsageError("startFrame must be a non-negative integer");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SceneBuilderUsageError);
    expect(error.name).toBe("SceneBuilderUsageError");
    expect(error.message).toBe("startFrame must be a non-negative integer");
  });

  it("is distinguishable from SceneBuildError via instanceof", () => {
    const usageError = new SceneBuilderUsageError("bad usage");
    const buildError = new SceneBuildError([{ path: "x", message: "y" }]);

    expect(usageError).not.toBeInstanceOf(SceneBuildError);
    expect(buildError).not.toBeInstanceOf(SceneBuilderUsageError);
  });
});
