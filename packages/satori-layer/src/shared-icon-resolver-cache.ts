import { createIconResolverCache, type IconResolverCache } from "./icon-resolver-cache.js";

/** The default `IconResolverCache` `resolveIconElements` draws from when a caller does not supply its own, shared process-wide the same way `sharedRenderLayerCache`/`sharedSvgRasterCache`/`sharedEmojiResolverCache` are. */
export const sharedIconResolverCache: IconResolverCache = createIconResolverCache();
