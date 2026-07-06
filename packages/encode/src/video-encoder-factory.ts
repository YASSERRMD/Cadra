/**
 * The `VideoEncoder` constructor, injectable for the same reason
 * `VideoFrameConstructor` is (see `video-frame-factory.ts`): this
 * Node/Vitest environment has no global `VideoEncoder`, so tests supply a
 * fake that records `configure`/`encode`/`flush`/`close` calls instead of
 * driving a real hardware/software codec.
 */
export type VideoEncoderConstructor = new (init: VideoEncoderInit) => VideoEncoder;

/**
 * Signature of `VideoEncoder.isConfigSupported`, injectable so codec
 * probing (`probeSupportedCodec` in `codec-probe.ts`) can be tested against
 * a fake reporting an arbitrary subset of codecs as supported, without a
 * real WebCodecs-capable environment.
 */
export type IsConfigSupportedFn = (config: VideoEncoderConfig) => Promise<VideoEncoderSupport>;

/**
 * Real global `VideoEncoder`, used as `encodeFrames`'s default constructor.
 * Only ever exercised in a real WebCodecs-capable environment (a browser or
 * a worker); tests inject a fake constructor instead.
 */
export function getGlobalVideoEncoderConstructor(): VideoEncoderConstructor | undefined {
  return typeof VideoEncoder === "undefined" ? undefined : VideoEncoder;
}

/**
 * Real global `VideoEncoder.isConfigSupported`, used as codec probing's
 * default. Bound to the `VideoEncoder` class so it can be called standalone
 * (static methods lose their `this` binding if just referenced as a bare
 * function value).
 */
export function getGlobalIsConfigSupported(): IsConfigSupportedFn | undefined {
  return typeof VideoEncoder === "undefined"
    ? undefined
    : VideoEncoder.isConfigSupported.bind(VideoEncoder);
}
