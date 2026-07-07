import { createEmojiResolverCache, type EmojiResolverCache } from "./emoji-resolver-cache.js";

/** The default `EmojiResolverCache` `renderLayerToSvg` draws from when a caller does not supply its own, shared process-wide the same way `sharedRenderLayerCache`/`sharedSvgRasterCache` are. */
export const sharedEmojiResolverCache: EmojiResolverCache = createEmojiResolverCache();
