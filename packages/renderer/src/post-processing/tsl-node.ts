/**
 * TSL's own node objects are proxy-wrapped at runtime with every
 * arithmetic/swizzle/sampling method attached, regardless of which narrow,
 * mutually incompatible declared subtype (`Node<"vec4">`, `TextureNode`,
 * `ToneMappingNode`, `ColorSpaceNode`, `TextureSizeNode`, ...)
 * `@types/three@0.185.0` happens to assign a particular TSL function's
 * return value (verified directly against this project's installed
 * `@types/three@0.185.0` declarations: no single exported type spans them,
 * even though every real TSL function - `uv()`, `vec2()`,
 * `pass(...).getTextureNode()`, `.mul()`, `.toneMapping()`, `.x`/`.y`
 * swizzles, ... - returns the exact same kind of proxy object at runtime).
 *
 * `AnyTslNode` is this package's one deliberate, narrow escape hatch for
 * building a node-graph accumulator that legitimately changes "declared
 * shape" across a chain of calls (sample -> mul -> toneMapping ->
 * workingToColorSpace -> ...) or a loop of unknown length (one call per
 * configured effect) - exactly the two patterns `@types/three`'s per-shape
 * typing cannot express without a cast at every single step. Used only for
 * that accumulator itself, never for this package's own public API: every
 * exported function still takes/returns concrete, real Three.js types.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTslNode = any;
