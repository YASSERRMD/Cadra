import type { JSX } from "react";

/**
 * Stub media/asset panel. Sits in the left sidebar, per this phase's design
 * grounding. Real asset browsing/import lands in Phase 40; this phase only
 * needs the layout slot to exist.
 */
export function AssetPanel(): JSX.Element {
  return (
    <div className="cadra-studio-panel cadra-studio-panel--asset" data-testid="studio-asset-panel">
      <span className="cadra-studio-panel__label">Assets (Phase 40)</span>
    </div>
  );
}
