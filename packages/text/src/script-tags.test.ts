import { describe, expect, it } from "vitest";

import { unicodeScriptToIso15924 } from "./script-tags.js";

describe("unicodeScriptToIso15924", () => {
  it("maps the scripts this codebase explicitly targets", () => {
    expect(unicodeScriptToIso15924("Latin")).toBe("Latn");
    expect(unicodeScriptToIso15924("Arabic")).toBe("Arab");
    expect(unicodeScriptToIso15924("Tamil")).toBe("Taml");
    expect(unicodeScriptToIso15924("Devanagari")).toBe("Deva");
  });

  it("falls back to the unknown-script tag for anything unmapped", () => {
    expect(unicodeScriptToIso15924("Nonexistent Script")).toBe("Zzzz");
  });
});
