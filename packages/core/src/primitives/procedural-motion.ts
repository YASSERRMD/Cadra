import { smoothNoise } from "../frame/smooth-noise.js";
import type { EasingName } from "../interpolation/named-easing.js";
import { resolveEasingFunction } from "../interpolation/named-easing.js";
import { resolveVector3Property } from "../keyframes/compile.js";
import type { Property } from "../keyframes/keyframe-track.js";
import type { Vector3 } from "../scene-graph/primitives.js";
import type { TextPathSegment } from "../scene-graph/scene-node.js";
import { createTextPathSampler, resolveTextPath } from "./text-path.js";

/**
 * Procedural motion helpers (Phase 70): each is a pure function of its own
 * `frame` (and, where noted, a seed), reusing this codebase's existing
 * deterministic primitives (`smoothNoise`, `resolveTextPath`/
 * `createTextPathSampler`, `resolveVector3Property`) rather than inventing
 * new ones, exactly like `resolveCountUpText`/`resolveScrambleText`
 * (`text-content-effects.ts`) and `resolveSatoriElementStyles`
 * (`satori-element-animation.ts`) - no new `SceneNode` kind or `Property<T>`
 * variant is needed, since `Property<T>` is a closed `T | KeyframeTrack<T>`
 * union with no extension point (see `keyframe-track.ts`'s own doc).
 *
 * An author (human or agent) calls one of these once per frame while
 * building a `KeyframeTrack<Vector3>` literal for a node's own
 * `transform.position`/`.rotation` (or any other `Property<Vector3>` field),
 * e.g.:
 *
 * ```ts
 * const keyframes = Array.from({ length: durationInFrames }, (_, frame) => ({
 *   frame,
 *   value: orbit({ radius: 3 }, frame, fps),
 * }));
 * ```
 *
 * Nothing here reads the wall clock or `Math.random()`; every helper is
 * called directly with its own inputs and returns a value that a later call
 * with the same inputs reproduces exactly.
 */

/** Config for `noiseMotion`. */
export interface NoiseMotionConfig {
  /** Combined with `":x"`/`":y"`/`":z"` suffixes so each axis wanders independently rather than in lockstep. Defaults to `0`. */
  seed?: number | string;
  /** The point the motion wanders around. Defaults to `[0, 0, 0]`. */
  center?: Vector3;
  /** How far the motion wanders from `center`, per axis. Defaults to `[1, 1, 1]`. */
  amplitude?: Vector3;
  /** Roughly how many seconds one full wander cycle takes (value noise is not perfectly periodic, so this is approximate). Higher is slower and smoother. Defaults to `2`. */
  periodSeconds?: number;
}

/**
 * Seeded, continuous wander around `config.center`, built on `smoothNoise`
 * (see that function's own doc for why raw per-frame randomness alone would
 * look like flickering static rather than an organic wobble). Each axis
 * uses its own independently seeded noise field, so the motion does not
 * collapse to a single wobbling line.
 */
export function noiseMotion(config: NoiseMotionConfig, frame: number, fps: number): Vector3 {
  const center = config.center ?? [0, 0, 0];
  const amplitude = config.amplitude ?? [1, 1, 1];
  const periodSeconds = config.periodSeconds ?? 2;
  const periodFrames = Math.max(1, periodSeconds * fps);
  const seed = config.seed ?? 0;

  const nx = smoothNoise(`${seed}:x`, frame, periodFrames);
  const ny = smoothNoise(`${seed}:y`, frame, periodFrames);
  const nz = smoothNoise(`${seed}:z`, frame, periodFrames);

  return [center[0] + nx * amplitude[0], center[1] + ny * amplitude[1], center[2] + nz * amplitude[2]];
}

/** Which world axis an `orbit`'s own circle is perpendicular to (i.e. the axis the object circles around). */
export type OrbitAxis = "x" | "y" | "z";

/** Config for `orbit`. */
export interface OrbitConfig {
  /** The point orbited around. Defaults to `[0, 0, 0]`. */
  center?: Vector3;
  /** Distance from `center`. Defaults to `1`. */
  radius?: number;
  /** Which axis the circular path is perpendicular to. Defaults to `"y"` (a circle in the XZ plane, the usual "orbit around an object" case). */
  axis?: OrbitAxis;
  /** Revolutions per second; negative reverses direction. Defaults to `0.25` (one full revolution every 4 seconds). */
  revolutionsPerSecond?: number;
  /** Starting angle, in radians. Defaults to `0`. */
  phase?: number;
}

/** Deterministic circular motion around `config.center`, at a constant angular speed. */
export function orbit(config: OrbitConfig, frame: number, fps: number): Vector3 {
  const center = config.center ?? [0, 0, 0];
  const radius = config.radius ?? 1;
  const axis = config.axis ?? "y";
  const revolutionsPerSecond = config.revolutionsPerSecond ?? 0.25;
  const phase = config.phase ?? 0;

  const angle = phase + 2 * Math.PI * revolutionsPerSecond * (frame / fps);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  switch (axis) {
    case "x":
      return [center[0], center[1] + radius * cos, center[2] + radius * sin];
    case "y":
      return [center[0] + radius * cos, center[1], center[2] + radius * sin];
    case "z":
      return [center[0] + radius * cos, center[1] + radius * sin, center[2]];
  }
}

/**
 * A path `followPath` moves along: the same `start`/`segments` shape
 * `TextPathConfig` uses (reusing `TextPathSegment`'s own line/quadratic/
 * cubic segments directly, each still independently `Property<Vector3>`, so
 * a deforming path is exactly as animatable as any other field), without
 * `TextPathConfig`'s own text-specific `spacing`/`alignment`/`orientation`
 * fields, which have no meaning for a general moving object.
 */
export interface MotionPathConfig {
  start: Property<Vector3>;
  segments: readonly TextPathSegment[];
}

/** One frame's own resolved position and direction of travel along a `MotionPathConfig`. */
export interface FollowPathResult {
  position: Vector3;
  /** Normalized direction of travel. `[0, 0, 0]` only for a fully degenerate (zero-length) path. Combine with `computeLookAtRotation([0,0,0], tangent)` to also orient toward the direction of travel. */
  tangent: Vector3;
}

/** Options for `followPath`, controlling how `frame` maps onto the path's own arc length. */
export interface FollowPathOptions {
  /** How many frames it takes to traverse the whole path once. */
  durationInFrames: number;
  /** Paces travel along the path's own arc length. Defaults to `"linear"` (constant speed). */
  easing?: EasingName;
  /** Whether progress wraps back to the path's start past `durationInFrames` (`true`) or holds at the end (`false`, the default). */
  loop?: boolean;
}

/**
 * Resolves `config` at `frame` (so a deforming path is fully animatable),
 * builds an arc-length sampler over it (`createTextPathSampler`, reused
 * as-is: framework-agnostic and already independently tested), and samples
 * it at whatever fraction of the path `frame` maps to.
 */
export function followPath(config: MotionPathConfig, frame: number, options: FollowPathOptions): FollowPathResult {
  const resolved = resolveTextPath(
    {
      start: config.start,
      segments: config.segments,
      orientation: "tangent",
      spacing: "advance",
      alignment: "start",
    },
    frame,
  );
  const sampler = createTextPathSampler(resolved);

  const duration = Math.max(1, options.durationInFrames);
  const rawProgress = frame / duration;
  const wrapped = options.loop === true ? rawProgress - Math.floor(rawProgress) : clamp01(rawProgress);
  const easedU = resolveEasingFunction(options.easing ?? "linear")(wrapped);

  const sample = sampler.sampleAt(easedU);
  return { position: sample.point, tangent: sample.tangent };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Computes the Euler XYZ rotation (radians, matching `AnimatableTransform`'s
 * own convention) that orients an object's local `-Z` axis toward `target`
 * from `eye`, with `up` (defaulting to world `+Y`) resolving the remaining
 * roll ambiguity around that axis - the exact same "eye, target, up"
 * convention `THREE.Camera`/`THREE.Light`'s own `lookAt()` uses internally
 * (verified directly against this project's installed `three` package: this
 * function's own output matches a real `THREE.Camera.lookAt(...)`'s
 * resulting Euler angles exactly, across straight-ahead, off-axis, and
 * degenerate eye-directly-above-target cases), so a non-camera node using
 * this baked rotation orients consistently with a camera or light using its
 * own live `target`.
 *
 * Degenerate only when `eye === target` (nothing to face) or when the
 * direction from `eye` to `target` is exactly parallel to `up`: both are
 * nudged by a small epsilon before the cross products below, mirroring
 * `Matrix4.lookAt`'s own handling of the identical cases.
 */
export function computeLookAtRotation(eye: Vector3, target: Vector3, up: Vector3 = [0, 1, 0]): Vector3 {
  let backward = normalize(subtract(eye, target), [0, 0, 1]);

  let right = normalize(cross(up, backward), [0, 0, 0]);
  if (right[0] === 0 && right[1] === 0 && right[2] === 0) {
    // `up` is parallel to `backward` (eye directly above/below target along
    // `up`'s own axis): nudge `backward` off-axis, mirroring Matrix4.lookAt's
    // own tie-breaking exactly (checking `up`'s own z-component, not
    // `backward`'s - only `up` is ever tested here) so `right` is
    // well-defined again.
    const nudged: Vector3 =
      Math.abs(up[2]) === 1
        ? [backward[0] + 0.0001, backward[1], backward[2]]
        : [backward[0], backward[1], backward[2] + 0.0001];
    backward = normalize(nudged, [0, 0, 1]);
    right = normalize(cross(up, backward), [1, 0, 0]);
  }

  const objectUp = cross(backward, right);

  // Rotation matrix columns are [right, objectUp, backward]; row 1 reads
  // each column's own x-component (m11=right.x, m12=objectUp.x,
  // m13=backward.x), row 2 each column's y-component, row 3 each column's
  // z-component - the standard basis-vectors-as-matrix-columns convention.
  const m11 = right[0];
  const m12 = objectUp[0];
  const m13 = backward[0];
  const m22 = objectUp[1];
  const m23 = backward[1];
  const m32 = objectUp[2];
  const m33 = backward[2];

  // THREE.Euler's own 'XYZ'-order extraction formula (Euler.setFromRotationMatrix).
  const y = Math.asin(clampUnit(m13));
  if (Math.abs(m13) < 0.9999999) {
    return [Math.atan2(-m23, m33), y, Math.atan2(-m12, m11)];
  }
  return [Math.atan2(m32, m22), y, 0];
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function subtract(a: Vector3, b: Vector3): Vector3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Normalizes `v`, or returns `fallback` unchanged if `v` is the zero vector (`eye === target`, or a degenerate cross product). */
function normalize(v: Vector3, fallback: Vector3): Vector3 {
  const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (length === 0) {
    return fallback;
  }
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Config for `secondarySpringMotion`: the same damped mass-spring-damper parameters as `SpringConfig` (`interpolation/spring.ts`), minus `from`/`to` - the moving target here is `primary` itself, not a fixed pair of endpoints. */
export interface SecondarySpringConfig {
  /** Mass of the spring's body. Higher mass reacts more sluggishly. Default `1`. */
  mass?: number;
  /** Spring stiffness (spring constant `k`). Higher stiffness settles faster. Default `100`. */
  stiffness?: number;
  /** Damping coefficient. Higher damping reduces oscillation/overshoot. Default `10`. */
  damping?: number;
}

/** Matches `interpolation/spring.ts`'s own fixed integration step exactly, so a secondary spring settles at a comparable rate to a primary one authored with the same `stiffness`/`damping`. */
const FIXED_STEP_SECONDS = 1 / 1000;

/**
 * Secondary motion (Phase 70): a damped mass-spring-damper body that chases
 * `primary` - itself a full `Property<Vector3>`, so it can be a constant, an
 * authored keyframe track, or another procedural helper's own per-frame
 * output - rather than a fixed endpoint the way `spring` (`interpolation/
 * spring.ts`) does. This is what makes secondary motion look attached: a
 * camera whose primary position stops abruptly still has this trailing,
 * settling toward wherever the primary track is *now*, exactly like a
 * physical object lagging behind its own mount point.
 *
 * Still a pure function of `(primary, config, frame, fps)`: re-integrates
 * from `elapsed = 0` (starting at the primary's own frame-0 value, at rest)
 * up to `frame / fps` on every call, using the same fixed 1ms step
 * `spring` itself uses, sampling `primary` at each step's own instantaneous
 * elapsed time as the current target - never caching position/velocity
 * between calls, so frame N's result never depends on which other frames
 * were evaluated before it or in what order.
 */
export function secondarySpringMotion(
  primary: Property<Vector3>,
  config: SecondarySpringConfig,
  frame: number,
  fps: number,
): Vector3 {
  const mass = config.mass ?? 1;
  const stiffness = config.stiffness ?? 100;
  const damping = config.damping ?? 10;

  const t = frame / fps;
  const initial = resolveVector3Property(primary, 0);
  if (t <= 0) {
    return initial;
  }

  let positionX = initial[0];
  let positionY = initial[1];
  let positionZ = initial[2];
  let velocityX = 0;
  let velocityY = 0;
  let velocityZ = 0;
  let elapsed = 0;

  while (elapsed < t) {
    const step = Math.min(FIXED_STEP_SECONDS, t - elapsed);
    const target = resolveVector3Property(primary, (elapsed + step) * fps);

    const accelerationX = (-stiffness * (positionX - target[0]) - damping * velocityX) / mass;
    const accelerationY = (-stiffness * (positionY - target[1]) - damping * velocityY) / mass;
    const accelerationZ = (-stiffness * (positionZ - target[2]) - damping * velocityZ) / mass;

    velocityX += accelerationX * step;
    velocityY += accelerationY * step;
    velocityZ += accelerationZ * step;
    positionX += velocityX * step;
    positionY += velocityY * step;
    positionZ += velocityZ * step;

    elapsed += step;
  }

  return [positionX, positionY, positionZ];
}
