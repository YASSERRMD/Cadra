import { describe, expect, it } from "vitest";

import { Text } from "./text.js";
import { TYPE_PRESETS } from "./type-presets.js";

describe("TYPE_PRESETS", () => {
  it("ships the title, lowerThird, caption, and kineticWordReveal presets", () => {
    expect(Object.keys(TYPE_PRESETS).sort()).toEqual(["caption", "kineticWordReveal", "lowerThird", "title"]);
  });

  it("groups every stagger by word or line, never character or grapheme", () => {
    // A per-character/grapheme reveal reads naturally only in one script's
    // own visual order; word/line grouping keys off reading-order rank
    // instead (see TYPE_PRESETS's own doc), so every preset here stays safe
    // for right-to-left and complex-script content without a caller having
    // to know to avoid character/grapheme grouping themselves.
    for (const [name, preset] of Object.entries(TYPE_PRESETS)) {
      if (preset.stagger !== undefined) {
        expect(["word", "line"], name).toContain(preset.stagger.grouping);
      }
    }
  });

  it("spreads cleanly into Text(), producing a valid TextNode for each preset", () => {
    for (const [name, preset] of Object.entries(TYPE_PRESETS)) {
      const node = Text({ id: `node-${name}`, ...preset, content: "Hello" });
      expect(node.kind).toBe("text");
      expect(node.content).toBe("Hello");
      expect(node.fontSize).toBe(preset.fontSize);
    }
  });

  it("does not mutate a preset when spread into two different Text() calls", () => {
    const before = JSON.parse(JSON.stringify(TYPE_PRESETS.title));
    Text({ id: "a", ...TYPE_PRESETS.title, content: "First" });
    Text({ id: "b", ...TYPE_PRESETS.title, fontSize: 40, content: "Second" });

    expect(TYPE_PRESETS.title).toEqual(before);
  });

  it("lets a caller override a single field via spread without needing the rest of the preset", () => {
    const node = Text({ id: "a", ...TYPE_PRESETS.title, fontSize: 120, content: "Big" });
    expect(node.fontSize).toBe(120);
    expect(node.stagger).toEqual(TYPE_PRESETS.title?.stagger);
  });
});
