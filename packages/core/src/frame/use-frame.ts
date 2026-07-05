import type { FrameContext } from "./frame-context.js";

/**
 * Reads the current frame index from an explicitly-passed `FrameContext`.
 *
 * There is no React and no implicit/ambient context propagation at this
 * layer: scene-authoring code always receives a `FrameContext` as a normal
 * function argument, and this accessor exists purely to give that read a
 * clear, intention-revealing name at call sites, matching the `useFrame`
 * naming convention scene-authoring code will already be familiar with.
 */
export function useFrame(context: FrameContext): number {
  return context.frame;
}
