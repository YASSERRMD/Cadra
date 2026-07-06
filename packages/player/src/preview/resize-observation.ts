/** Plain width/height, as reported by a resize observation callback. */
export interface ObservedSize {
  width: number;
  height: number;
}

/** Stops observing the element passed to `observeResize`. */
export type UnobserveResizeFn = () => void;

/**
 * Starts observing `element` for size changes, invoking `onResize` with its
 * new content-box size whenever it changes. Returns a function that stops
 * observing.
 *
 * Injectable so tests can drive resize behavior deterministically: real
 * `ResizeObserver` requires an actual layout engine to ever fire (jsdom does
 * not implement one, see this package's `mount-preview.test.ts`), the same
 * problem `Transport`'s `now`/`scheduleFrame` injectability solves for
 * wall-clock time. A test can supply a fake that records `onResize` and
 * exposes a way to invoke it manually with synthetic dimensions.
 */
export type ObserveResizeFn = (
  element: Element,
  onResize: (size: ObservedSize) => void,
) => UnobserveResizeFn;

/**
 * Default `ObserveResizeFn` backed by a real `ResizeObserver`. Reads the
 * first `ResizeObserverEntry`'s `contentRect` per callback invocation (one
 * entry is expected, since exactly one element is ever observed per call).
 */
export const observeResizeWithResizeObserver: ObserveResizeFn = (element, onResize) => {
  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry === undefined) {
      return;
    }
    onResize({ width: entry.contentRect.width, height: entry.contentRect.height });
  });
  observer.observe(element);
  return () => observer.disconnect();
};
