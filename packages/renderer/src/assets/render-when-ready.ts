import type { Pending } from "@cadra/core";
import { waitForAssets } from "@cadra/core";

/**
 * Gates a render behind every pending asset the current scene references.
 *
 * `render` (representing "any function needing asset access", per this
 * phase's scope) is only invoked after `waitForAssets` resolves for all of
 * `pendingAssets`; if any of them rejects, `render` is never called and the
 * rejection propagates instead. This is the readiness contract the rest of
 * the pipeline exists to serve: a headless render must never draw a frame
 * against a partially-loaded asset, so nothing calls a renderer's
 * `renderFrame` directly with unresolved assets in play, it calls this.
 */
export async function renderWhenAssetsReady<T>(
  pendingAssets: Iterable<Pending>,
  render: () => T,
): Promise<T> {
  await waitForAssets(pendingAssets);
  return render();
}
