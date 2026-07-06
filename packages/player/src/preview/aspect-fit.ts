/** A plain width/height pixel size. */
export interface FitSize {
  width: number;
  height: number;
}

/**
 * Computes the largest size that fits within `container` while exactly
 * preserving `composition`'s aspect ratio ("contain" fit: letterbox when the
 * container is wider than the composition's ratio, pillarbox when it is
 * narrower). Never stretches.
 *
 * Plain numbers in, plain numbers out, same rationale as
 * `pointerPositionToFrame`: a real layout engine is not available under the
 * DOM test environment this is tested against, so the fit math itself is
 * factored out to be directly testable without one.
 *
 * Returns `{ width: 0, height: 0 }` if either input dimension is zero or
 * negative, since there is no meaningful fit to compute (e.g. a container
 * not yet laid out).
 */
export function computeAspectFitSize(container: FitSize, composition: FitSize): FitSize {
  if (
    container.width <= 0 ||
    container.height <= 0 ||
    composition.width <= 0 ||
    composition.height <= 0
  ) {
    return { width: 0, height: 0 };
  }

  const containerRatio = container.width / container.height;
  const compositionRatio = composition.width / composition.height;

  if (containerRatio > compositionRatio) {
    // Container is relatively wider than the composition: height is the
    // binding dimension, width pillarboxes to less than the container's full
    // width.
    const height = container.height;
    const width = height * compositionRatio;
    return { width, height };
  }

  // Container is relatively narrower than (or an exact match to) the
  // composition: width is the binding dimension, height letterboxes to less
  // than the container's full height.
  const width = container.width;
  const height = width / compositionRatio;
  return { width, height };
}
