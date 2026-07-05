/**
 * Standard easing curves: pure functions `(t: number) => number` mapping
 * normalized progress in `[0, 1]` to eased progress. Every curve here
 * satisfies `easing(0) === 0` and `easing(1) === 1` (i.e. clamps to the same
 * boundary values as the identity curve at the endpoints), so any of them
 * can be dropped into `interpolate`'s `options.easing` without shifting
 * where a segment starts or ends, only how it gets there.
 *
 * Naming: `easeIn*` starts slow, `easeOut*` ends slow, `easeInOut*` does
 * both (mirrored halves).
 */

/** Identity curve: no easing, `t` maps straight to `t`. */
export function linear(t: number): number {
  return t;
}

// --- Cubic ---

export function easeInCubic(t: number): number {
  return t * t * t;
}

export function easeOutCubic(t: number): number {
  const inverse = 1 - t;
  return 1 - inverse * inverse * inverse;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// --- Exponential ---

export function easeInExpo(t: number): number {
  return t === 0 ? 0 : Math.pow(2, 10 * t - 10);
}

export function easeOutExpo(t: number): number {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export function easeInOutExpo(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
}

// --- Back (overshoot) ---

/** Standard overshoot constant used by the `back` family, per Robert Penner's original easing equations. */
const BACK_OVERSHOOT = 1.70158;

export function easeInBack(t: number): number {
  const c1 = BACK_OVERSHOOT;
  const c3 = c1 + 1;
  return c3 * t * t * t - c1 * t * t;
}

export function easeOutBack(t: number): number {
  const c1 = BACK_OVERSHOOT;
  const c3 = c1 + 1;
  const inverse = t - 1;
  return 1 + c3 * inverse * inverse * inverse + c1 * inverse * inverse;
}

export function easeInOutBack(t: number): number {
  const c1 = BACK_OVERSHOOT;
  const c2 = c1 * 1.525;
  return t < 0.5
    ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
}

// --- Elastic ---

/** Angular period shared by the `elastic` family (in units of `t`). */
const ELASTIC_PERIOD = (2 * Math.PI) / 3;

export function easeInElastic(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ELASTIC_PERIOD);
}

export function easeOutElastic(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC_PERIOD) + 1;
}

export function easeInOutElastic(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  const period = (2 * Math.PI) / 4.5;
  return t < 0.5
    ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * period)) / 2
    : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * period)) / 2 + 1;
}

// --- Cubic Bezier (CSS `cubic-bezier()` semantics) ---

/** Newton-Raphson iterations attempted before falling back to bisection. */
const NEWTON_ITERATIONS = 8;
/** Stop refining once consecutive Newton steps change `t` by less than this. */
const NEWTON_EPSILON = 1e-7;
/** Bisection iterations used as a guaranteed-convergent fallback. */
const BISECTION_ITERATIONS = 30;
/** Bisection stops early once the bracket is tighter than this. */
const BISECTION_EPSILON = 1e-7;

/**
 * Evaluates a cubic Bezier's coordinate (x or y) at parameter `t`, given the
 * two control-point coordinates (the curve's start and end are fixed at 0
 * and 1). This is the standard Bernstein-basis cubic Bezier formula for
 * control points at (0, p1, p2, 1).
 */
function bezierCoordinate(t: number, p1: number, p2: number): number {
  const oneMinusT = 1 - t;
  return 3 * oneMinusT * oneMinusT * t * p1 + 3 * oneMinusT * t * t * p2 + t * t * t;
}

/** Derivative of `bezierCoordinate` with respect to `t`, used by the Newton-Raphson step. */
function bezierCoordinateDerivative(t: number, p1: number, p2: number): number {
  const oneMinusT = 1 - t;
  return 3 * oneMinusT * oneMinusT * p1 + 6 * oneMinusT * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

/**
 * Generic CSS-style `cubic-bezier(x1, y1, x2, y2)` timing function, matching
 * the semantics of the CSS `cubic-bezier()` easing function: the curve runs
 * from (0, 0) to (1, 1) with control points (x1, y1) and (x2, y2), and
 * `x` (progress) is solved for the corresponding `y` (eased output).
 *
 * Solves `x(t) = x` for `t` via Newton-Raphson (following the same approach
 * as WebKit's `UnitBezier` implementation, used by CSS engines), falling
 * back to bisection for any `x` where Newton's method fails to converge
 * (e.g. a zero derivative at the guess), since bisection is slower but
 * always converges given a valid bracket.
 *
 * `x1`/`x2` are expected in `[0, 1]` (as CSS requires, so the curve is a
 * function of `x`, i.e. monotonic in `t` for the x-coordinate); `y1`/`y2`
 * may be outside `[0, 1]` to produce overshoot, matching CSS.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  return function timingFunction(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // Newton-Raphson: start from the identity guess `t = x`, refine using
    // the derivative of the x-coordinate curve.
    let t = x;
    for (let i = 0; i < NEWTON_ITERATIONS; i += 1) {
      const currentX = bezierCoordinate(t, x1, x2) - x;
      if (Math.abs(currentX) < NEWTON_EPSILON) {
        return bezierCoordinate(t, y1, y2);
      }
      const derivative = bezierCoordinateDerivative(t, x1, x2);
      if (Math.abs(derivative) < NEWTON_EPSILON) {
        break;
      }
      t -= currentX / derivative;
    }

    // Fallback: bisection on t within [0, 1], which always converges since
    // bezierCoordinate(t, x1, x2) is monotonic in t for x1/x2 in [0, 1].
    let lowerT = 0;
    let upperT = 1;
    t = x;
    for (let i = 0; i < BISECTION_ITERATIONS; i += 1) {
      const currentX = bezierCoordinate(t, x1, x2);
      if (Math.abs(currentX - x) < BISECTION_EPSILON) {
        break;
      }
      if (currentX < x) {
        lowerT = t;
      } else {
        upperT = t;
      }
      t = (lowerT + upperT) / 2;
    }

    return bezierCoordinate(t, y1, y2);
  };
}
