import type { IconResolverCache } from "./icon-resolver-cache.js";
import type { LayerElement } from "./layer-element.js";
import { sharedIconResolverCache } from "./shared-icon-resolver-cache.js";

/** Lucide's own native icon size (every bundled icon is authored at `viewBox="0 0 24 24"`), used when an `icon` element does not specify its own `width`/`height`. */
const DEFAULT_ICON_SIZE = 24;

function resolveIconElement(element: LayerElement, iconCache: IconResolverCache): LayerElement {
  const resolvedSrc = element.icon === undefined ? undefined : iconCache.resolve(element.icon, element.style?.color);
  return {
    ...(element.id !== undefined && { id: element.id }),
    type: "img",
    ...(element.style !== undefined && { style: element.style }),
    ...(element.lang !== undefined && { lang: element.lang }),
    ...(resolvedSrc !== undefined && { src: resolvedSrc }),
    width: element.width ?? DEFAULT_ICON_SIZE,
    height: element.height ?? DEFAULT_ICON_SIZE,
  };
}

/**
 * Recursively replaces every `type: "icon"` element in `element`'s own tree
 * with the `type: "img"` element it resolves to (see `icon-resolver.ts`):
 * `icon` (the bundled icon's name) becomes `src` (a resolved `data:` URI,
 * recolored from `style.color` when set), and `width`/`height` default to
 * `DEFAULT_ICON_SIZE` when the author left them unset. An icon name with no
 * matching bundled asset resolves to an `img` with no `src` at all (Satori
 * then simply paints nothing there, the same graceful degradation an
 * unresolved `TextRenderRegistry`/`SatoriLayerRenderRegistry` entry gets
 * elsewhere in this renderer, rather than throwing mid-render over one bad
 * icon name).
 *
 * `element` itself is never mutated: every node on the path from the root
 * to a resolved icon (and the icon itself) is shallow-copied; every other
 * node is returned unchanged. Mirrors `applyElementAnimations`'s own
 * recursive-rebuild shape exactly, run once per `renderLayerToSvg` call
 * rather than per frame (an icon's own resolved pixels do not depend on
 * `frame` the way `elementAnimations` do, only on its name and, if
 * `elementAnimations` targets its `color`, on whichever frame is being
 * rendered - which is why this runs after `applyElementAnimations`, not
 * before, in `renderLayerToSvg`'s own pipeline).
 */
export function resolveIconElements(
  element: LayerElement,
  iconCache: IconResolverCache = sharedIconResolverCache,
): LayerElement {
  if (element.type === "icon") {
    return resolveIconElement(element, iconCache);
  }

  const children = element.children?.map((child) =>
    typeof child === "string" ? child : resolveIconElements(child, iconCache),
  );
  return children === undefined ? element : { ...element, children };
}
