export { createIdGenerator } from "./id-generator.js";
export type { AnimatableTransform, ColorRGBA, Transform, Vector2, Vector3 } from "./primitives.js";
export { createIdentityTransform } from "./primitives.js";
export type { CreateProjectInput } from "./project-factory.js";
export { createProject } from "./project-factory.js";
export type {
  CameraNode,
  CompositionRefNode,
  GroupNode,
  ImageNode,
  LightNode,
  LightType,
  MeshNode,
  SceneNode,
  SceneNodeKind,
  TextNode,
  VideoBlendMode,
  VideoFitMode,
  VideoNode,
  VideoOutOfRangeBehavior,
} from "./scene-node.js";
export type {
  ActiveCameraEntry,
  AudioClip,
  AudioFadeEnvelope,
  AudioTrack,
  Clip,
  Composition,
  Project,
  Track,
  Transition,
} from "./timeline.js";
export { SceneNodeNotFoundError } from "./tree-operations.js";
export { addNode, findNode, removeNode, updateNode } from "./tree-operations.js";
