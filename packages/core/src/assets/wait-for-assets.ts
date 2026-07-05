/** Anything that reports its own asset-loading completion as a promise. */
export interface Pending {
  ready: Promise<unknown>;
}

/**
 * Resolves only once every item in `pending` has resolved its own `ready`
 * promise; rejects as soon as any one of them rejects. A render must never
 * proceed until this resolves for every asset the current scene references,
 * so no frame is ever drawn against a partially-loaded asset.
 *
 * A thin, deliberately unclever `Promise.all` wrapper: `pending` is generic
 * over anything shaped like `{ ready: Promise<unknown> }`, so it works
 * equally over core's own future asset-like values and over
 * `packages/renderer`'s concrete loaded-asset handles, without either
 * depending on the other's types.
 */
export async function waitForAssets(pending: Iterable<Pending>): Promise<void> {
  await Promise.all(Array.from(pending, (item) => item.ready));
}
