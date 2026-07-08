import type { Property } from "../keyframes/keyframe-track.js";
import { type AnimatableTransform, createIdentityTransform } from "../scene-graph/primitives.js";
import type {
  ParticleBlendMode,
  ParticleColliderConfig,
  ParticleColorStop,
  ParticleEmitterShape,
  ParticleForceConfig,
  ParticleSizeStop,
  ParticleSystemNode,
} from "../scene-graph/scene-node.js";

/**
 * Props for `Particles`. Only `id` is required; every other emitter field
 * defaults to a small, visible-out-of-the-box configuration (see `Particles`'
 * own doc for the exact defaults), the same zero-config philosophy `Shape`'s
 * own `"box"`/`"default"` placeholders establish.
 *
 * `transform` and `visible` each accept either a plain value or a
 * `KeyframeTrack` (Phase 10's `Property<T>`); passing a plain value, as every
 * existing caller of every other primitive does, keeps working unchanged.
 */
export interface ParticlesProps {
  id: string;
  name?: string;
  transform?: AnimatableTransform;
  visible?: Property<boolean>;
  children?: ParticleSystemNode["children"];
  maxParticles?: number;
  emissionRate?: number;
  shape?: ParticleEmitterShape;
  lifetimeSeconds?: number;
  lifetimeVarianceSeconds?: number;
  initialSpeed?: number;
  initialSpeedVariance?: number;
  direction?: ParticleSystemNode["direction"];
  spreadAngle?: number;
  startSize?: number;
  sizeVariance?: number;
  forces?: readonly ParticleForceConfig[];
  colliders?: readonly ParticleColliderConfig[];
  colorOverLife?: readonly ParticleColorStop[];
  sizeOverLife?: readonly ParticleSizeStop[];
  textureRef?: string;
  blendMode?: ParticleBlendMode;
  seed?: number;
}

/**
 * Creates a `ParticleSystemNode`: a GPU-simulated particle emitter (Phase 67).
 *
 * Defaults: identity transform, `visible: true`, no children, `maxParticles:
 * 1000`, `emissionRate: 100`, a `{type: "point"}` emitter shape,
 * `lifetimeSeconds: 2`, `initialSpeed: 1`, `direction: [0, 1, 0]` (straight
 * up), `startSize: 0.1`, no forces, no colliders, no color/size-over-life
 * curves (opaque white, constant size), no texture (a plain soft circular
 * sprite), `blendMode: "normal"`.
 */
export function Particles(props: ParticlesProps): ParticleSystemNode {
  return {
    id: props.id,
    kind: "particles",
    ...(props.name !== undefined && { name: props.name }),
    transform: props.transform ?? createIdentityTransform(),
    visible: props.visible ?? true,
    children: props.children ?? [],
    maxParticles: props.maxParticles ?? 1000,
    emissionRate: props.emissionRate ?? 100,
    shape: props.shape ?? { type: "point" },
    lifetimeSeconds: props.lifetimeSeconds ?? 2,
    ...(props.lifetimeVarianceSeconds !== undefined && {
      lifetimeVarianceSeconds: props.lifetimeVarianceSeconds,
    }),
    initialSpeed: props.initialSpeed ?? 1,
    ...(props.initialSpeedVariance !== undefined && {
      initialSpeedVariance: props.initialSpeedVariance,
    }),
    direction: props.direction ?? [0, 1, 0],
    ...(props.spreadAngle !== undefined && { spreadAngle: props.spreadAngle }),
    startSize: props.startSize ?? 0.1,
    ...(props.sizeVariance !== undefined && { sizeVariance: props.sizeVariance }),
    ...(props.forces !== undefined && { forces: props.forces }),
    ...(props.colliders !== undefined && { colliders: props.colliders }),
    ...(props.colorOverLife !== undefined && { colorOverLife: props.colorOverLife }),
    ...(props.sizeOverLife !== undefined && { sizeOverLife: props.sizeOverLife }),
    ...(props.textureRef !== undefined && { textureRef: props.textureRef }),
    ...(props.blendMode !== undefined && { blendMode: props.blendMode }),
    ...(props.seed !== undefined && { seed: props.seed }),
  };
}
