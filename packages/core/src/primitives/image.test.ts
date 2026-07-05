import { describe, expect, it } from "vitest";

import { createIdentityTransform } from "../scene-graph/primitives.js";
import { Image } from "./image.js";

describe("Image", () => {
  it("applies every default when only id is given", () => {
    const node = Image({ id: "image-1" });

    expect(node).toEqual({
      id: "image-1",
      kind: "image",
      transform: createIdentityTransform(),
      visible: true,
      children: [],
      assetRef: "default",
    });
  });

  it("overrides every default when props are given", () => {
    const node = Image({
      id: "image-1",
      name: "Logo",
      visible: false,
      assetRef: "logo.png",
    });

    expect(node).toEqual({
      id: "image-1",
      kind: "image",
      name: "Logo",
      transform: createIdentityTransform(),
      visible: false,
      children: [],
      assetRef: "logo.png",
    });
  });
});
