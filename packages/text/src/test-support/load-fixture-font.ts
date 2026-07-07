import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Loads a real OFL-licensed variable font from `test-fixtures/fonts/` for
 * tests to parse. These are genuine Google Fonts variable-font binaries
 * (not synthetic/truncated stubs), chosen to exercise this package's real
 * range of scripts and axes: `RobotoFlex` (Latin, four axes including
 * weight/width/slant), `Inter` (Latin, weight/optical-size), `NotoSansArabic`
 * and `NotoSansTamil` (weight/width, complex-script shaping fixtures for
 * Phase 42), and `NotoNastaliqUrdu` (weight, Urdu).
 */
export type FixtureFontName =
  | "RobotoFlex-Variable"
  | "Inter-Variable"
  | "NotoSansArabic-Variable"
  | "NotoSansTamil-Variable"
  | "NotoNastaliqUrdu-Variable";

export function loadFixtureFont(name: FixtureFontName): Uint8Array {
  const path = fileURLToPath(new URL(`../../test-fixtures/fonts/${name}.ttf`, import.meta.url));
  return new Uint8Array(readFileSync(path));
}
