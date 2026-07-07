import type { JSX } from "react";

/**
 * Stub inspector (properties) panel. Sits in the right sidebar, per this
 * phase's design grounding. Real property editing lands in Phase 39; this
 * phase only needs the layout slot to exist.
 */
export function InspectorPanel(): JSX.Element {
  return (
    <div
      className="cadra-studio-panel cadra-studio-panel--inspector"
      data-testid="studio-inspector-panel"
    >
      <span className="cadra-studio-panel__label">Inspector (Phase 39)</span>
    </div>
  );
}
