/**
 * The `AudioEncoder` constructor, injectable for the same reason
 * `VideoEncoderConstructor` is (see `video-encoder-factory.ts`): this
 * Node/Vitest environment has no global `AudioEncoder`, so tests supply a
 * fake that records `configure`/`encode`/`flush`/`close` calls instead of
 * driving a real hardware/software codec.
 */
export type AudioEncoderConstructor = new (init: AudioEncoderInit) => AudioEncoder;

/**
 * Signature of `AudioEncoder.isConfigSupported`, injectable so codec
 * probing (`probeSupportedAudioCodec` in `audio-codec-probe.ts`) can be
 * tested against a fake reporting an arbitrary subset of codecs as
 * supported, without a real WebCodecs-capable environment.
 */
export type IsAudioConfigSupportedFn = (config: AudioEncoderConfig) => Promise<AudioEncoderSupport>;

/**
 * Real global `AudioEncoder`, used as `encodeAudio`'s default constructor.
 * Only ever exercised in a real WebCodecs-capable environment (a browser or
 * a worker); tests inject a fake constructor instead.
 */
export function getGlobalAudioEncoderConstructor(): AudioEncoderConstructor | undefined {
  return typeof AudioEncoder === "undefined" ? undefined : AudioEncoder;
}

/**
 * Real global `AudioEncoder.isConfigSupported`, used as codec probing's
 * default. Bound to the `AudioEncoder` class so it can be called standalone
 * (static methods lose their `this` binding if just referenced as a bare
 * function value).
 */
export function getGlobalIsAudioConfigSupported(): IsAudioConfigSupportedFn | undefined {
  return typeof AudioEncoder === "undefined"
    ? undefined
    : AudioEncoder.isConfigSupported.bind(AudioEncoder);
}
