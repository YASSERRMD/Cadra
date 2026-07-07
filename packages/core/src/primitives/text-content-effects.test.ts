import { describe, expect, it } from "vitest";

import type { TextPhysicsConfig } from "../scene-graph/scene-node.js";
import { resolveCountUpText, resolveScrambleText } from "./text-content-effects.js";

const SCRAMBLE: TextPhysicsConfig = {
  effect: "scramble",
  grouping: "character",
  startFrame: 0,
  delayFrames: 2,
  durationFrames: 1,
  charset: "X",
};

describe("resolveScrambleText", () => {
  it("shows the real text once every character has locked in", () => {
    // 5 characters, delayFrames=2, durationFrames=1: last character (rank 4)
    // locks in at frame 0 + 4*2 + 1 = 9.
    expect(resolveScrambleText("Hello", SCRAMBLE, 9)).toBe("Hello");
  });

  it("shows a scrambled (charset) character before a character's own lock-in frame", () => {
    // With a single-character charset ("X"), the scrambled output is
    // fully deterministic and directly assertable.
    const result = resolveScrambleText("Hello", SCRAMBLE, 0);
    // Rank 0 ("H") locks in at frame 0 + 0*2 + 1 = 1, so at frame 0 it is
    // still scrambled to "X".
    expect(result[0]).toBe("X");
  });

  it("never scrambles whitespace", () => {
    const result = resolveScrambleText("Hi there", SCRAMBLE, 0);
    expect(result[2]).toBe(" ");
  });

  it("locks in characters progressively, earlier ranks before later ones (forward direction)", () => {
    const atFrame1 = resolveScrambleText("Hello", SCRAMBLE, 1);
    // Rank 0 ("H", locks in at frame 1) is real; rank 1 ("e", locks in at
    // frame 3) is still scrambled.
    expect(atFrame1[0]).toBe("H");
    expect(atFrame1[1]).toBe("X");
  });

  it("reverses lock-in order under backward direction", () => {
    const backward: TextPhysicsConfig = { ...SCRAMBLE, direction: "backward" };
    // Backward: last character ("o", index 4) gets rank 0, locking in at
    // frame 1; first character ("H", index 0) gets rank 4, locking in at
    // frame 9.
    const result = resolveScrambleText("Hello", backward, 1);
    expect(result[4]).toBe("o");
    expect(result[0]).toBe("X");
  });

  it("only draws scrambled characters from the configured charset", () => {
    const config: TextPhysicsConfig = { ...SCRAMBLE, charset: "AB", durationFrames: 100 };
    const result = resolveScrambleText("Hello", config, 0);
    for (const char of result) {
      if (char !== " ") {
        expect(["A", "B"]).toContain(char);
      }
    }
  });

  it("is deterministic: the same (text, config, frame) always resolves to the same string", () => {
    const first = resolveScrambleText("Hello, World!", { ...SCRAMBLE, charset: "ABCDEFGHIJ" }, 2);
    const second = resolveScrambleText("Hello, World!", { ...SCRAMBLE, charset: "ABCDEFGHIJ" }, 2);
    expect(second).toBe(first);
  });

  it("evaluating frames out of order gives the same result as evaluating in order", () => {
    const config: TextPhysicsConfig = { ...SCRAMBLE, charset: "ABCDEFGHIJ", durationFrames: 50 };
    const inOrder = [0, 3, 7].map((frame) => resolveScrambleText("Hello", config, frame));
    const outOfOrder = [7, 0, 3].map((frame) => resolveScrambleText("Hello", config, frame));
    expect(outOfOrder[1]).toBe(inOrder[0]);
    expect(outOfOrder[2]).toBe(inOrder[1]);
    expect(outOfOrder[0]).toBe(inOrder[2]);
  });

  it("preserves a real Unicode grapheme (e.g. an emoji) as one unit once locked in", () => {
    const result = resolveScrambleText("Hi \u{1F600}", SCRAMBLE, 100);
    expect(result).toBe("Hi \u{1F600}");
  });
});

describe("resolveCountUpText", () => {
  const COUNT_UP: TextPhysicsConfig = {
    effect: "countUp",
    grouping: "line",
    startFrame: 0,
    durationFrames: 10,
    fromValue: 0,
    toValue: 100,
  };

  it("shows fromValue at or before startFrame", () => {
    expect(resolveCountUpText(COUNT_UP, 0)).toBe("0");
    expect(resolveCountUpText(COUNT_UP, -5)).toBe("0");
  });

  it("shows toValue at or after startFrame + durationFrames", () => {
    expect(resolveCountUpText(COUNT_UP, 10)).toBe("100");
    expect(resolveCountUpText(COUNT_UP, 50)).toBe("100");
  });

  it("shows an interpolated value at the midpoint", () => {
    expect(resolveCountUpText(COUNT_UP, 5)).toBe("50");
  });

  it("formats with fixed decimal places", () => {
    const config: TextPhysicsConfig = { ...COUNT_UP, decimalPlaces: 2 };
    expect(resolveCountUpText(config, 5)).toBe("50.00");
  });

  it("groups digits with a thousands separator when useGrouping is set, regardless of runtime locale", () => {
    const config: TextPhysicsConfig = { ...COUNT_UP, toValue: 1000000, useGrouping: true };
    expect(resolveCountUpText(config, 10)).toBe("1,000,000");
  });

  it("does not group digits by default", () => {
    const config: TextPhysicsConfig = { ...COUNT_UP, toValue: 1000000 };
    expect(resolveCountUpText(config, 10)).toBe("1000000");
  });

  it("applies a non-default easing curve to the count's own progress", () => {
    const linear = resolveCountUpText(COUNT_UP, 5);
    const eased = resolveCountUpText({ ...COUNT_UP, easing: "easeInCubic" }, 5);
    expect(linear).toBe("50");
    expect(eased).toBe("13"); // easeInCubic(0.5) = 0.125 -> 12.5 -> rounds to 13 via NumberFormat with 0 decimals
  });

  it("counts down just as well when fromValue is greater than toValue", () => {
    const config: TextPhysicsConfig = { ...COUNT_UP, fromValue: 100, toValue: 0 };
    expect(resolveCountUpText(config, 5)).toBe("50");
  });

  it("is deterministic", () => {
    const first = resolveCountUpText(COUNT_UP, 3);
    const second = resolveCountUpText(COUNT_UP, 3);
    expect(second).toBe(first);
  });
});
