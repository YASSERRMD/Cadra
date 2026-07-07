import type { PreviewHandle } from "@cadra/player";
import type { SceneDocument, SceneParseDiagnostic } from "@cadra/schema";
import type { JSX } from "react";
import { useEffect, useState } from "react";

import { findSelectedClip } from "../inspector/find-selected-clip.js";
import { NODE_KIND_PROPERTY_DESCRIPTORS } from "../inspector/property-descriptors.js";
import type { AnyPropertyValue } from "../inspector/property-path.js";
import { getPropertyAtPath, setPropertyAtPath } from "../inspector/property-path.js";
import { replaceNodeInDocument } from "../store/document-edits.js";
import { PropertyEditor } from "./PropertyEditor.js";

/** Props for `InspectorPanel`. */
export interface InspectorPanelProps {
  /** The current scene document; the selected node (if any) is looked up from it via `selectedNodeId`. */
  document: SceneDocument;
  /**
   * Which `SceneNode` (by id) is currently selected, or `undefined` if
   * nothing is. Set via `TimelinePanel`'s clip clicks (see that
   * component's own doc, and `document-store.ts`'s `selectNode`); this
   * panel only ever reads it, never sets it.
   */
  selectedNodeId: string | undefined;
  /**
   * The live `PreviewHandle` shared with `Viewport`/`TimelinePanel` (see
   * those components' own docs). Used for two things: resolving each
   * property's concrete display value at the handle's current frame (via
   * its `onFrameChanged` subscription, the same pattern `TimelinePanel`
   * already uses for its own playhead), and seeking to a keyframe's frame
   * when that keyframe is selected in the keyframe editor (Phase 39's task
   * 4, reusing Phase 38's `seek`).
   */
  previewHandle: PreviewHandle | undefined;
  /**
   * Commits a candidate `SceneDocument` (built by splicing an edited
   * property back into the selected node/clip; see `replaceNodeInDocument`)
   * through the store's `commitDocument` funnel, returning `undefined` on
   * success or the rejected edit's diagnostics on failure. A thin
   * `App.tsx`-level wrapper around the store's own `commitDocument`; see
   * that component's `commitPropertyEdit` for why reading the diagnostics
   * back out is safe to do synchronously.
   */
  commitPropertyEdit: (candidate: unknown) => SceneParseDiagnostic[] | undefined;
}

/**
 * The property inspector: for the currently selected node (see
 * `selectedNodeId`'s own doc for how a node becomes selected), renders one
 * `PropertyEditor` per animatable property that node's `kind` actually has
 * (`NODE_KIND_PROPERTY_DESCRIPTORS`, Phase 7's per-primitive property
 * descriptors), two-way bound to the scene document via `commitPropertyEdit`
 * (Phase 39's whole deliverable).
 *
 * Current-frame tracking mirrors `TimelinePanel`'s own playhead sync
 * exactly: initialize from `previewHandle.getFrame()` on mount/handle
 * change, then subscribe to `onFrameChanged` for every subsequent change
 * (playback, a viewport/timeline scrub, or this panel's own keyframe-select
 * `seek` calls), so every property editor always resolves its display value
 * against the same live playhead position the rest of the app shows.
 */
export function InspectorPanel({
  document,
  selectedNodeId,
  previewHandle,
  commitPropertyEdit,
}: InspectorPanelProps): JSX.Element {
  const [currentFrame, setCurrentFrame] = useState(0);

  useEffect(() => {
    if (previewHandle === undefined) {
      return undefined;
    }
    setCurrentFrame(previewHandle.getFrame());
    const unsubscribe = previewHandle.onFrameChanged((frame) => {
      setCurrentFrame(frame);
    });
    return unsubscribe;
  }, [previewHandle]);

  const match = findSelectedClip(document, selectedNodeId);

  if (match === undefined) {
    return (
      <div
        className="cadra-studio-panel cadra-studio-panel--inspector"
        data-testid="studio-inspector-panel"
      >
        <span className="cadra-studio-panel__label">No node selected.</span>
      </div>
    );
  }

  const descriptors = NODE_KIND_PROPERTY_DESCRIPTORS[match.node.kind];

  function handleSeek(frame: number): void {
    previewHandle?.seek(frame);
  }

  return (
    <div
      className="cadra-studio-inspector"
      data-testid="studio-inspector-panel"
    >
      <div className="cadra-studio-inspector__header">
        <span className="cadra-studio-inspector__node-label">
          {match.node.name ?? match.node.id}
        </span>
        <span className="cadra-studio-inspector__node-kind">{match.node.kind}</span>
      </div>
      {descriptors.map((descriptor) => (
        <PropertyEditor
          key={descriptor.path}
          descriptor={descriptor}
          property={getPropertyAtPath(match.node, descriptor.path)}
          currentFrame={currentFrame}
          onSeek={handleSeek}
          onCommitProperty={(next: AnyPropertyValue) => {
            const nextNode = setPropertyAtPath(match.node, descriptor.path, next);
            const candidate = replaceNodeInDocument(document, match, nextNode);
            return commitPropertyEdit(candidate);
          }}
        />
      ))}
    </div>
  );
}
