import "fontkit";

/**
 * `fontkit@2.0.4`'s `TTFFont` exposes a real `namedVariations` getter
 * (`src/TTFFont.js`: named `fvar` instances mapped to their axis
 * coordinates) that never made it into the published `@types/fontkit`
 * declarations. Declared here, verified directly against the installed
 * package's own source rather than guessed.
 */
declare module "fontkit" {
  interface Font {
    namedVariations: Record<string, Record<string, number>>;
  }
}
