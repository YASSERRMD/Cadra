import type { SceneNode } from "../scene-graph/scene-node.js";
import type { Clip } from "../scene-graph/timeline.js";
import { Sequence } from "./sequence.js";

/**
 * One entry in a `Series`. `id` becomes the produced `Clip`'s id: required
 * explicitly (per entry) rather than derived, since a `Series` can have any
 * number of entries and there is no single base id to derive them from.
 */
export interface SeriesEntry {
  id: string;
  durationInFrames: number;
  content: SceneNode;
}

/**
 * Lays out `entries` back to back on a single implicit timeline: the first
 * entry starts at frame 0, and every later entry starts immediately after
 * the cumulative duration of every entry before it (its `from` is never
 * passed explicitly).
 *
 * Produces a `Clip[]`, not a `Track`, so callers stay free to assemble the
 * result into whichever `Track` (or split across multiple tracks) they want.
 */
export function Series(entries: SeriesEntry[]): Clip[] {
  const clips: Clip[] = [];
  let from = 0;

  for (const entry of entries) {
    clips.push(
      Sequence({
        id: entry.id,
        from,
        durationInFrames: entry.durationInFrames,
        content: entry.content,
      }),
    );
    from += entry.durationInFrames;
  }

  return clips;
}
