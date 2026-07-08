import {
  CAMERA_ANIMATABLE_PROPERTIES,
  EASING_FUNCTIONS,
  IMAGE_ANIMATABLE_PROPERTIES,
  LIGHT_ANIMATABLE_PROPERTIES,
  MODEL_ANIMATABLE_PROPERTIES,
  PARTICLES_ANIMATABLE_PROPERTIES,
  SATORI_ANIMATABLE_PROPERTIES,
  SHAPE_ANIMATABLE_PROPERTIES,
  TEXT_ANIMATABLE_PROPERTIES,
  VIDEO_ANIMATABLE_PROPERTIES,
  VOLUME_ANIMATABLE_PROPERTIES,
} from "@cadra/core";

import { CURRENT_SCHEMA_VERSION } from "./envelope.js";
import { sceneNodeKindSchema } from "./scene-node.js";

/**
 * The capability manifest: a machine-readable description of what an
 * agent can actually put in a Cadra scene document, beyond what the JSON
 * Schema alone conveys (the JSON Schema describes *shape*; this describes
 * *vocabulary*, e.g. exactly which easing curve names exist and which
 * dot-paths on each primitive are genuinely keyframeable).
 *
 * Every field here is sourced directly from `@cadra/core` and
 * `@cadra/schema`'s own schemas (`primitives`, `properties`, `easings`),
 * both of which this package already depends on. `codecs` is deliberately
 * different: see its own doc comment below for why it lives here only as
 * an optional, well-typed extension point rather than real data.
 *
 * `schemaVersion` is `CURRENT_SCHEMA_VERSION`, so a consumer that persists or
 * caches a manifest can tell which contract version it was generated
 * against, the same versioning discipline every other Phase 27 export
 * follows (see `describeCadraContract` in `./describe.ts`).
 */
export interface CapabilityManifest {
  /** The schema contract version this manifest describes. */
  schemaVersion: number;
  /** Every scene node kind a document may use, and which of its dot-paths are keyframeable. */
  primitives: PrimitiveCapability[];
  /** Every named easing curve a keyframe's `easing` field may reference. */
  easings: EasingCapability[];
  /**
   * Optional, extensible codec capability data.
   *
   * `@cadra/schema` is a foundational package: `@cadra/encode` (which owns
   * real codec preference/probing data, see `packages/encode/src/codec-probe.ts`)
   * depends on layers below it, not the other way around, and
   * `@cadra/encode`'s own `package.json` does not depend on `@cadra/schema`.
   * Adding a dependency from `schema` on `encode` here would invert that
   * layering for the sake of one field, so this package never populates
   * `codecs` itself; `generateCapabilityManifest` always returns it
   * `undefined`.
   *
   * This field exists, typed, so a higher-level consumer that legitimately
   * depends on both packages (the Phase 28 MCP server is the intended
   * example) can merge real codec data into a manifest it re-exports,
   * without needing its own parallel `CapabilityManifest`-shaped type:
   * `{ ...generateCapabilityManifest(), codecs: realCodecsFromEncode }` is a
   * complete, well-typed manifest. See `CodecCapability` for the expected
   * shape of each entry.
   */
  codecs?: CodecCapability[];
}

/** One scene node kind and the dot-paths on it that accept a `Property<T>` (a plain value or a keyframe track). */
export interface PrimitiveCapability {
  /** The node's `kind` discriminant, e.g. `"mesh"` or `"camera"`. */
  kind: string;
  /**
   * Dot-paths into this node kind's shape that are genuinely keyframeable,
   * e.g. `"transform.position"` or `"fontSize"`. Sourced from
   * `@cadra/core`'s `*_ANIMATABLE_PROPERTIES` lists, which (as of Phase 26)
   * are guaranteed to name only fields that are actually `Property<T>`-typed
   * on the corresponding `SceneNode` variant.
   */
  animatableProperties: readonly string[];
}

/** One named easing curve a `Keyframe`'s `easing` field may reference. */
export interface EasingCapability {
  /** The easing curve's name, e.g. `"linear"` or `"easeInOutCubic"`. */
  name: string;
  /**
   * Whether this name maps to a continuous `(t: number) => number` blend
   * function, or is the special `"hold"` step behavior (stay at the
   * starting keyframe's value, then jump at the next keyframe's frame, with
   * no continuous curve of its own). Mirrors the `ContinuousEasing` versus
   * `"hold"` distinction in `@cadra/core`'s `keyframes/easing.ts`.
   */
  continuous: boolean;
}

/**
 * Expected shape for one entry a higher-level consumer merges into a
 * manifest's optional `codecs` field. Not populated by anything in this
 * package; declared here purely so that consumer has a shared, well-typed
 * shape to target rather than inventing its own.
 */
export interface CodecCapability {
  /** Human-readable codec name, e.g. `"AV1"`. */
  label: string;
  /** The underlying codec string (e.g. a WebCodecs `VideoEncoderConfig.codec` value). */
  codec: string;
  /** Whether this codec was confirmed supported in the environment that produced the manifest. */
  supported: boolean;
}

/** Every scene node kind, paired with the exported animatable-property list `@cadra/core` documents for it. */
const PRIMITIVE_ANIMATABLE_PROPERTIES: Record<string, readonly string[]> = {
  group: ["transform.position", "transform.rotation", "transform.scale", "visible"],
  mesh: SHAPE_ANIMATABLE_PROPERTIES,
  camera: CAMERA_ANIMATABLE_PROPERTIES,
  light: LIGHT_ANIMATABLE_PROPERTIES,
  text: TEXT_ANIMATABLE_PROPERTIES,
  image: IMAGE_ANIMATABLE_PROPERTIES,
  video: VIDEO_ANIMATABLE_PROPERTIES,
  compositionRef: ["transform.position", "transform.rotation", "transform.scale", "visible"],
  satori: SATORI_ANIMATABLE_PROPERTIES,
  particles: PARTICLES_ANIMATABLE_PROPERTIES,
  volume: VOLUME_ANIMATABLE_PROPERTIES,
  model: MODEL_ANIMATABLE_PROPERTIES,
};

/**
 * Builds the list of `PrimitiveCapability` entries, one per `SceneNodeKind`
 * (via `sceneNodeKindSchema`'s own enum values, so this can never silently
 * drift from the set of kinds the parser actually accepts).
 *
 * `group` and `compositionRef` have no dedicated exported
 * `*_ANIMATABLE_PROPERTIES` constant in `@cadra/core` (every node kind
 * shares `transform` and `visible` via `SceneNodeBase`, but only the kinds
 * with additional animatable fields of their own get a named export), so
 * both fall back to the shared transform-plus-visibility set inline above.
 */
function buildPrimitiveCapabilities(): PrimitiveCapability[] {
  return sceneNodeKindSchema.options.map((kind) => ({
    kind,
    animatableProperties: PRIMITIVE_ANIMATABLE_PROPERTIES[kind] ?? [],
  }));
}

/**
 * Builds the list of `EasingCapability` entries: every continuous easing
 * `@cadra/core`'s `EASING_FUNCTIONS` lookup names, plus `"hold"`, which has
 * no function in that lookup since it is a step behavior rather than a
 * curve (see `EasingCapability.continuous`'s doc comment).
 */
function buildEasingCapabilities(): EasingCapability[] {
  const continuous = Object.keys(EASING_FUNCTIONS).map((name) => ({ name, continuous: true }));
  return [...continuous, { name: "hold", continuous: false }];
}

/**
 * Generates the capability manifest: every scene node primitive and its
 * keyframeable properties, every named easing curve, and an always-`undefined`
 * `codecs` extension point for a higher-level consumer to fill in (see
 * `CapabilityManifest.codecs`'s doc comment for why this package cannot
 * populate it itself).
 *
 * Called by `describeCadraContract` (`./describe.ts`) to compose the full
 * runtime contract; also exported directly for a caller that only needs the
 * capability manifest on its own.
 */
export function generateCapabilityManifest(): CapabilityManifest {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    primitives: buildPrimitiveCapabilities(),
    easings: buildEasingCapabilities(),
  };
}
