import type { Project, SceneNode } from "@cadra/core";

/**
 * Every distinct asset ref a `Project` references, grouped by the registry
 * kind it needs to populate. Walks every composition in the project (not
 * only whichever one is currently previewed), mirroring `@cadra/encode`'s
 * own `render-job.ts` collection helpers exactly: a `CompositionRefNode`
 * pointing at another composition never needs separate recursion-handling
 * this way, since that other composition's own nodes are already visited
 * directly by this same top-level loop.
 */
export interface CollectedAssetRefs {
  images: Set<string>;
  videos: Set<string>;
  models: Set<string>;
  environments: Set<string>;
  luts: Set<string>;
  audio: Set<string>;
}

function collectFromNode(node: SceneNode, refs: CollectedAssetRefs): void {
  if (node.kind === "image") {
    refs.images.add(node.assetRef);
  } else if (node.kind === "video") {
    refs.videos.add(node.assetRef);
  } else if (node.kind === "model") {
    refs.models.add(node.assetRef);
  }
  for (const child of node.children) {
    collectFromNode(child, refs);
  }
}

/**
 * Collects every asset ref `project` references anywhere: `ImageNode`/
 * `VideoNode`/`ModelNode.assetRef` (recursively, across every composition's
 * own node tree), `CompositionEnvironment.envMapRef`, `LutEffectConfig.lutRef`
 * (inside `postProcessing.effects`), and `AudioClip.assetRef` (inside
 * `audioTracks`). Used by `build-preview-registries.ts` to know exactly
 * which assets the live viewport needs to fetch before it can render
 * anything but the documented placeholder for each kind.
 */
export function collectAssetRefs(project: Project): CollectedAssetRefs {
  const refs: CollectedAssetRefs = {
    images: new Set(),
    videos: new Set(),
    models: new Set(),
    environments: new Set(),
    luts: new Set(),
    audio: new Set(),
  };

  for (const composition of project.compositions) {
    for (const track of composition.tracks) {
      for (const clip of track.clips) {
        collectFromNode(clip.node, refs);
      }
    }
    if (composition.environment !== undefined) {
      refs.environments.add(composition.environment.envMapRef);
    }
    for (const effect of composition.postProcessing?.effects ?? []) {
      if (effect.type === "lut") {
        refs.luts.add(effect.lutRef);
      }
    }
    for (const track of composition.audioTracks ?? []) {
      for (const clip of track.clips) {
        refs.audio.add(clip.assetRef);
      }
    }
  }

  return refs;
}
