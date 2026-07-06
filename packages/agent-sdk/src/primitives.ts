import {
  Camera as createCameraNode,
  type CameraProps,
  Image as createImageNode,
  type ImageProps,
  Light as createLightNode,
  type LightProps,
  Shape as createShapeNode,
  type ShapeProps,
  Text as createTextNode,
  type TextProps,
} from "@cadra/core";

import { NodeBuilder } from "./node-builder.js";

/**
 * Builder-flavored mirrors of every Phase 7 primitive factory
 * (`Text`/`Image`/`Shape`/`Camera`/`Light`), each returning a `NodeBuilder`
 * instead of a bare `SceneNode` so the result can be `.animate()`d and
 * `.at()`-placed on a timeline in one fluent chain.
 *
 * These wrap `@cadra/core`'s own factories exactly (same `Props` shape, same
 * defaults): nothing about node construction itself is reimplemented here,
 * only the fluent wrapper on top of the returned node.
 */

/** Builder-flavored `Text`: wraps `@cadra/core`'s `Text` factory. */
export function Text(props: TextProps): NodeBuilder<ReturnType<typeof createTextNode>> {
  return new NodeBuilder(createTextNode(props));
}

/** Builder-flavored `Image`: wraps `@cadra/core`'s `Image` factory. */
export function Image(props: ImageProps): NodeBuilder<ReturnType<typeof createImageNode>> {
  return new NodeBuilder(createImageNode(props));
}

/** Builder-flavored `Shape`: wraps `@cadra/core`'s `Shape` factory. */
export function Shape(props: ShapeProps): NodeBuilder<ReturnType<typeof createShapeNode>> {
  return new NodeBuilder(createShapeNode(props));
}

/** Builder-flavored `Camera`: wraps `@cadra/core`'s `Camera` factory. */
export function Camera(props: CameraProps): NodeBuilder<ReturnType<typeof createCameraNode>> {
  return new NodeBuilder(createCameraNode(props));
}

/** Builder-flavored `Light`: wraps `@cadra/core`'s `Light` factory. */
export function Light(props: LightProps): NodeBuilder<ReturnType<typeof createLightNode>> {
  return new NodeBuilder(createLightNode(props));
}
