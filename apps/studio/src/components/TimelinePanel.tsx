import type { JSX } from "react";

/**
 * Stub timeline panel. Runs full-width along the bottom of the shell, per
 * this phase's design grounding (a full-width timeline along the bottom is
 * the consistent convention across Runway/Canva/VEED/TikTok Studio/Vidyard).
 * Real timeline editing (scrubbing, clip/track manipulation) lands in Phase
 * 38; this phase only needs the layout slot to exist.
 */
export function TimelinePanel(): JSX.Element {
  return (
    <div
      className="cadra-studio-panel cadra-studio-panel--timeline"
      data-testid="studio-timeline-panel"
    >
      <span className="cadra-studio-panel__label">Timeline (Phase 38)</span>
    </div>
  );
}
