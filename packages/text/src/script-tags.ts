/**
 * Maps a Unicode script name (as returned by `unicode-properties`'
 * `getScript`, e.g. `"Arabic"`, `"Tamil"`) to its four-letter ISO 15924
 * script tag, which is what HarfBuzz's `Buffer.setScript` expects. Covers
 * the scripts this codebase explicitly targets (Latin, Arabic, Tamil,
 * Devanagari for Urdu/Hindi-adjacent shaping) plus enough other major
 * scripts that mixed-script text does not silently fall back to the
 * wrong script.
 */
export const UNICODE_SCRIPT_TO_ISO_15924: Readonly<Record<string, string>> = {
  Latin: "Latn",
  Arabic: "Arab",
  Tamil: "Taml",
  Devanagari: "Deva",
  Han: "Hani",
  Hiragana: "Hira",
  Katakana: "Kana",
  Hangul: "Hang",
  Cyrillic: "Cyrl",
  Greek: "Grek",
  Hebrew: "Hebr",
  Thai: "Thai",
  Bengali: "Beng",
  Gujarati: "Gujr",
  Gurmukhi: "Guru",
  Kannada: "Knda",
  Malayalam: "Mlym",
  Oriya: "Orya",
  Sinhala: "Sinh",
  Telugu: "Telu",
  Armenian: "Armn",
  Georgian: "Geor",
  Myanmar: "Mymr",
  Khmer: "Khmr",
  Lao: "Laoo",
};

/**
 * Scripts that carry no shaping identity of their own (punctuation,
 * digits, combining marks, whitespace): these must never start their own
 * itemized run and instead join whichever real-script run they are
 * adjacent to (see `script-runs.ts`).
 */
export const SCRIPT_LESS_UNICODE_SCRIPTS: ReadonlySet<string> = new Set([
  "Common",
  "Inherited",
  "Unknown",
]);

/** Resolves a Unicode script name to its ISO 15924 tag, falling back to `"Zzzz"` (Unicode's own "unknown script" tag) for anything not in the table. */
export function unicodeScriptToIso15924(scriptName: string): string {
  return UNICODE_SCRIPT_TO_ISO_15924[scriptName] ?? "Zzzz";
}
