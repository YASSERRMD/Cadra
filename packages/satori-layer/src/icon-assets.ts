import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * `lucide-static` ships one plain `.svg` file per icon (`icons/<name>.svg`,
 * `stroke="currentColor"` throughout so a consumer can recolor by setting
 * `color` on the root, see `icon-resolver.ts`) rather than a JS/React
 * component wrapper, which is exactly what a framework-agnostic, no-JSX
 * renderer like this one needs: read the file directly, no icon-component
 * runtime required. `createRequire` mirrors `twemoji-assets.ts`'s own
 * pattern for locating a sibling npm package's bundled asset from ESM.
 */
const require = createRequire(import.meta.url);
const LUCIDE_ICONS_DIR = join(dirname(require.resolve("lucide-static/package.json")), "icons");

/** Every character a Lucide icon name is ever actually built from (lowercase letters, digits, hyphens - kebab-case). Validated before ever touching the filesystem so an icon name can never be used to escape `LUCIDE_ICONS_DIR` (e.g. `"../../etc/passwd"`) or reach an unintended file. */
const VALID_ICON_NAME = /^[a-z0-9-]+$/;

/**
 * Reads one named icon's raw SVG source from the locally installed
 * `lucide-static` package, or `undefined` if `icon` is not a real Lucide
 * icon name (including any name shaped so it could not possibly be one, per
 * `VALID_ICON_NAME`, rejected before any filesystem access is attempted).
 */
export function resolveLucideIconSvgText(icon: string): string | undefined {
  if (!VALID_ICON_NAME.test(icon)) {
    return undefined;
  }
  try {
    return readFileSync(join(LUCIDE_ICONS_DIR, `${icon}.svg`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
