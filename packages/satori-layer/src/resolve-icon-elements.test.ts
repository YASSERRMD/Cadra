import { describe, expect, it } from "vitest";

import { createIconResolverCache } from "./icon-resolver-cache.js";
import type { LayerElement } from "./layer-element.js";
import { resolveIconElements } from "./resolve-icon-elements.js";

describe("resolveIconElements", () => {
  it("resolves a top-level icon element to an img with a data: URI src", () => {
    const cache = createIconResolverCache();
    const resolved = resolveIconElements({ type: "icon", icon: "arrow-right" }, cache);

    expect(resolved.type).toBe("img");
    expect(resolved.icon).toBeUndefined();
    expect(resolved.src).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("defaults width/height to 24 (Lucide's own native size) when unset", () => {
    const cache = createIconResolverCache();
    const resolved = resolveIconElements({ type: "icon", icon: "arrow-right" }, cache);
    expect(resolved.width).toBe(24);
    expect(resolved.height).toBe(24);
  });

  it("preserves an author-specified width/height instead of defaulting", () => {
    const cache = createIconResolverCache();
    const resolved = resolveIconElements(
      { type: "icon", icon: "arrow-right", width: 48, height: 32 },
      cache,
    );
    expect(resolved.width).toBe(48);
    expect(resolved.height).toBe(32);
  });

  it("recolors the resolved icon from style.color", () => {
    const cache = createIconResolverCache();
    const resolved = resolveIconElements(
      { type: "icon", icon: "arrow-right", style: { color: "#ff0000" } },
      cache,
    );
    const decoded = Buffer.from(
      (resolved.src as string).slice("data:image/svg+xml;base64,".length),
      "base64",
    ).toString("utf8");
    expect(decoded).toContain('color="#ff0000"');
  });

  it("preserves id/style/lang across the icon-to-img conversion", () => {
    const cache = createIconResolverCache();
    const resolved = resolveIconElements(
      { id: "cta-icon", type: "icon", icon: "arrow-right", style: { color: "red" }, lang: "en" },
      cache,
    );
    expect(resolved.id).toBe("cta-icon");
    expect(resolved.style).toEqual({ color: "red" });
    expect(resolved.lang).toBe("en");
  });

  it("resolves an icon with no matching bundled asset to an img with no src at all", () => {
    const cache = createIconResolverCache();
    const resolved = resolveIconElements({ type: "icon", icon: "not-a-real-icon" }, cache);
    expect(resolved.type).toBe("img");
    expect(resolved.src).toBeUndefined();
  });

  it("recurses into nested children, resolving icons anywhere in the tree", () => {
    const cache = createIconResolverCache();
    const tree: LayerElement = {
      type: "div",
      children: [
        "hello",
        {
          type: "div",
          children: [{ type: "icon", icon: "arrow-right" }],
        },
      ],
    };

    const resolved = resolveIconElements(tree, cache);

    expect(resolved.children?.[0]).toBe("hello");
    const innerDiv = resolved.children?.[1] as LayerElement;
    const resolvedIcon = innerDiv.children?.[0] as LayerElement;
    expect(resolvedIcon.type).toBe("img");
    expect(resolvedIcon.src).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("leaves a tree with no icon elements structurally unchanged", () => {
    const cache = createIconResolverCache();
    const tree: LayerElement = { type: "div", children: ["hello"] };
    const resolved = resolveIconElements(tree, cache);
    expect(resolved).toEqual(tree);
  });

  it("does not mutate the original tree", () => {
    const cache = createIconResolverCache();
    const tree: LayerElement = { type: "icon", icon: "arrow-right" };
    resolveIconElements(tree, cache);
    expect(tree.type).toBe("icon");
    expect(tree.src).toBeUndefined();
  });
});
