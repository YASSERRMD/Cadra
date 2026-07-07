import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseFontWithFontkit } from "@cadra/text";
import satori from "satori";
import { describe, expect, it } from "vitest";

import { instanceFontForSatori, resolveFullVariationPin } from "./satori-font-instancing.js";

function loadFixtureFont(name: string): Uint8Array {
  // Reused directly from @cadra/text's own test fixtures rather than
  // duplicating multi-megabyte font files: both packages live in this one
  // monorepo, and this is test-only code, never published.
  const path = fileURLToPath(
    new URL(`../../text/test-fixtures/fonts/${name}.ttf`, import.meta.url),
  );
  return new Uint8Array(readFileSync(path));
}

const INTER_VARIABLE_BYTES = loadFixtureFont("Inter-Variable");
const INTER_VARIABLE = parseFontWithFontkit(INTER_VARIABLE_BYTES);

describe("resolveFullVariationPin", () => {
  it("pins every one of the font's own axes, defaulting unmentioned ones to their own declared default", () => {
    const pin = resolveFullVariationPin(INTER_VARIABLE, { wght: 700 });
    // Inter-Variable has exactly opsz and wght (verified empirically).
    expect(pin).toEqual({ opsz: INTER_VARIABLE.variationAxes.find((a) => a.tag === "opsz")?.default, wght: 700 });
  });

  it("returns every axis at its own default when nothing is requested", () => {
    const pin = resolveFullVariationPin(INTER_VARIABLE, undefined);
    for (const axis of INTER_VARIABLE.variationAxes) {
      expect(pin[axis.tag]).toBe(axis.default);
    }
  });

  it("returns an empty pin for a font with no variation axes", () => {
    const staticFont = { ...INTER_VARIABLE, variationAxes: [] };
    expect(resolveFullVariationPin(staticFont, { wght: 700 })).toEqual({});
  });
});

describe("instanceFontForSatori", () => {
  it("produces bytes dramatically smaller than the source variable font", async () => {
    const instanced = await instanceFontForSatori(INTER_VARIABLE, "Hello", { wght: 700 });
    expect(instanced.length).toBeLessThan(INTER_VARIABLE.bytes.length / 10);
  });

  it("is deterministic across repeated calls with the same inputs", async () => {
    const first = await instanceFontForSatori(INTER_VARIABLE, "Hello Cadra", { wght: 700 });
    const second = await instanceFontForSatori(INTER_VARIABLE, "Hello Cadra", { wght: 700 });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it("produces bytes different from a different requested weight", async () => {
    const regular = await instanceFontForSatori(INTER_VARIABLE, "Hello", { wght: 400 });
    const bold = await instanceFontForSatori(INTER_VARIABLE, "Hello", { wght: 700 });
    expect(Buffer.from(regular).equals(Buffer.from(bold))).toBe(false);
  });

  it("produces bytes Satori's own font parser can actually load without throwing", async () => {
    // This is the real regression test for the whole reason this function
    // exists: Satori's bundled opentype.js fork throws when handed a font
    // that still has an active variation axis (verified empirically
    // against this exact fixture before this function existed). Handing
    // the *un*-instanced source bytes to Satori directly is exactly the
    // failure this guards against.
    const instanced = await instanceFontForSatori(INTER_VARIABLE, "Hi", { wght: 700 });

    await expect(
      satori(
        { type: "div", props: { style: { fontSize: 20, color: "black" }, children: "Hi" } },
        {
          width: 100,
          height: 50,
          fonts: [{ name: "Inter", data: Buffer.from(instanced), weight: 700, style: "normal" }],
        },
      ),
    ).resolves.toContain("<svg");
  });
});
