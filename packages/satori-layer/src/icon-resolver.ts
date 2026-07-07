import { resolveLucideIconSvgText } from "./icon-assets.js";

function escapeXmlAttributeValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Matches the root `<svg` opening tag's first whitespace or `>`, i.e. right after the tag name and before its first attribute (or its close), the insertion point for an injected `color` attribute. */
const SVG_ROOT_TAG_BOUNDARY = /<svg(\s|>)/;

/**
 * Sets `color` on `svgText`'s root `<svg>` element, so every descendant
 * `stroke="currentColor"`/`fill="currentColor"` (every Lucide icon's own
 * convention) resolves to it: a standalone SVG document (this one is about
 * to be embedded via a `data:` URI, isolated from whatever document embeds
 * it) resolves `currentColor` through ordinary CSS inheritance starting from
 * its own root, so setting `color` there is sufficient, no stylesheet or
 * per-element rewrite needed. Returns `svgText` unchanged when `color` is
 * `undefined` (the icon keeps whatever color it would otherwise resolve to,
 * i.e. `currentColor` continuing to mean "inherited from further out,"
 * which for a rasterized standalone document means black).
 */
export function recolorSvgText(svgText: string, color: string | undefined): string {
  if (color === undefined) {
    return svgText;
  }
  const escapedColor = escapeXmlAttributeValue(color);
  return svgText.replace(
    SVG_ROOT_TAG_BOUNDARY,
    (_match, boundary: string) => `<svg color="${escapedColor}"${boundary}`,
  );
}

function svgTextToDataUri(svgText: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svgText, "utf8").toString("base64")}`;
}

/**
 * Resolves a named icon (optionally recolored) to a `data:` URI, or
 * `undefined` if `icon` is not a real Lucide icon name. Uncached; see
 * `icon-resolver-cache.ts` for the cached entry point every real caller
 * (`resolve-icon-elements.ts`) actually uses.
 */
export function resolveIconDataUri(icon: string, color: string | undefined): string | undefined {
  const svgText = resolveLucideIconSvgText(icon);
  return svgText === undefined ? undefined : svgTextToDataUri(recolorSvgText(svgText, color));
}
