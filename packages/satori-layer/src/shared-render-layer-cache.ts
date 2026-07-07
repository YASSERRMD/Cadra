import { createRenderLayerCache, type RenderLayerCache } from "./render-layer-cache.js";

/**
 * The process-wide default render-layer cache any caller renders a layer
 * through unless it injects its own (e.g. for test isolation). Mirrors
 * `@cadra/text`'s `sharedAtlasCache` exactly.
 */
export const sharedRenderLayerCache: RenderLayerCache = createRenderLayerCache();
