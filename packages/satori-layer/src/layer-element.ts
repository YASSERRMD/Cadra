/**
 * Re-exported from `@cadra/core`, not redefined here: `@cadra/core` is
 * this package's own dependency and hosts the canonical definition (Phase
 * 48's `SatoriNode.layer` field needs this same type, and `@cadra/core`
 * cannot depend on `@cadra/satori-layer` without a circular dependency),
 * so there is exactly one `LayerElement`/`LayerStyle` shape, not two
 * that could silently drift apart.
 */
export type { LayerElement, LayerElementType, LayerStyle } from "@cadra/core";
