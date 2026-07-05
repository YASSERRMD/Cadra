import { describe, expect, it } from "vitest";

import { createProject } from "./project-factory.js";

describe("createProject", () => {
  it("constructs a project with the given id and name", () => {
    const project = createProject({ id: "p1", name: "My Project" });

    expect(project.id).toBe("p1");
    expect(project.name).toBe("My Project");
  });

  it("defaults compositions to an empty array when omitted", () => {
    const project = createProject({ id: "p1", name: "My Project" });

    expect(project.compositions).toEqual([]);
  });

  it("uses the compositions passed in", () => {
    const composition = {
      id: "c1",
      name: "Comp",
      fps: 30,
      durationInFrames: 60,
      width: 1280,
      height: 720,
      tracks: [],
    };

    const project = createProject({ id: "p1", name: "My Project", compositions: [composition] });

    expect(project.compositions).toEqual([composition]);
  });

  it("does not mutate the compositions array passed in", () => {
    const compositions = [
      {
        id: "c1",
        name: "Comp",
        fps: 30,
        durationInFrames: 60,
        width: 1280,
        height: 720,
        tracks: [],
      },
    ];

    const project = createProject({ id: "p1", name: "My Project", compositions });
    project.compositions.push({
      id: "c2",
      name: "Extra",
      fps: 24,
      durationInFrames: 24,
      width: 640,
      height: 480,
      tracks: [],
    });

    expect(compositions).toHaveLength(1);
  });
});
