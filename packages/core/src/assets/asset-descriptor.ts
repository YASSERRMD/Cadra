/**
 * Environment-agnostic asset description: what kind of asset it is and
 * where its bytes come from. Carries no loaded bytes or decoded resource
 * itself; `packages/renderer`'s loaders are what turns a descriptor into a
 * real resource, since decoding is inherently browser/DOM-API-shaped and
 * does not belong in this environment-agnostic package.
 */

/** The kinds of asset the pipeline knows how to load. */
export type AssetKind = "image" | "video" | "font" | "gltf" | "audio";

/** Identifies one loadable asset: what kind it is, and where to fetch it from. */
export interface AssetDescriptor {
  kind: AssetKind;
  /** Source location bytes are fetched from, e.g. a URL or file path. */
  url: string;
}
