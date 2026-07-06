/**
 * The narrow subset of the real Web Audio API `renderAudioMixdown` actually
 * drives: node creation (`createBufferSource`, `createGain`), `destination`,
 * and `startRendering()` to produce a final `AudioBufferLike`. Mirrors
 * `@cadra/player`'s `audio-context-like.ts` (see its own top-level doc for
 * the full rationale): `OfflineAudioContext`/`AudioBuffer` do not exist in
 * this headless Node/Vitest environment either, so every real construct this
 * module touches is expressed as one of these structural interfaces and
 * injected.
 *
 * Unlike live playback's `AudioContextLike` (driven by a real-time clock,
 * scheduling nodes as the transport ticks), this is an *offline* render: one
 * `startRendering()` call produces the entire composition's audio in one
 * shot, which is exactly what a real `OfflineAudioContext` is for. A real
 * `OfflineAudioContext` satisfies `OfflineAudioContextLike` structurally
 * (and a real `AudioBuffer` satisfies `AudioBufferLike`), so
 * `createDefaultOfflineAudioContextLike` is a zero-cost identity wrapper,
 * not an adapter that translates calls, exactly like
 * `createDefaultAudioContextLike`.
 *
 * This package does not need `OfflineAudioContext` to work in plain
 * server-side Node without a browser: it is available in a real browser, and
 * Phase 23's headless-Chromium server render path is a real browser, exactly
 * like `VideoEncoder`/`VideoFrame` (`video-encoder-factory.ts`/
 * `video-frame-factory.ts`) already don't need to work in plain Node either.
 */

/** The gain/`.value`-bearing scheduling surface this module needs from a real `AudioParam`. */
export interface OfflineAudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

/** Anything a source or gain node can `connect()` to: another node, or the context's destination. */
export interface OfflineAudioNodeLike {
  connect(destination: OfflineAudioNodeLike): unknown;
  disconnect(): unknown;
}

/** The playback-control surface this module needs from a real `GainNode`. */
export interface OfflineGainNodeLike extends OfflineAudioNodeLike {
  gain: OfflineAudioParamLike;
}

/**
 * The scheduling surface this module needs from a real
 * `AudioBufferSourceNode`: one-shot, exactly like the real thing (see
 * `@cadra/player`'s `AudioBufferSourceNodeLike` for the same one-shot
 * caveat), scheduled once via `start()` and never reused.
 */
export interface OfflineAudioBufferSourceNodeLike extends OfflineAudioNodeLike {
  buffer: AudioBufferLike | null;
  start(when?: number, offset?: number, duration?: number): unknown;
  stop(when?: number): unknown;
}

/**
 * The subset of a real `AudioBuffer` this module needs: enough identity
 * (`duration`/`length`/`sampleRate`/`numberOfChannels`) for a caller to
 * inspect the rendered result, plus `getChannelData` for a caller (e.g. a
 * later encoding stage) to read the actual PCM samples back out.
 */
export interface AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * The subset of a real `OfflineAudioContext` this module needs: a final
 * output node (`destination`), factories for the two node kinds it
 * schedules, and `startRendering()` to produce the finished
 * `AudioBufferLike` once every source/gain node has been scheduled.
 */
export interface OfflineAudioContextLike {
  readonly length: number;
  readonly sampleRate: number;
  readonly destination: OfflineAudioNodeLike;
  createBufferSource(): OfflineAudioBufferSourceNodeLike;
  createGain(): OfflineGainNodeLike;
  startRendering(): Promise<AudioBufferLike>;
}

/** Options accepted by `createDefaultOfflineAudioContextLike`, mirroring `OfflineAudioContextOptions`. */
export interface DefaultOfflineAudioContextOptions {
  /** Number of audio channels to render. */
  numberOfChannels: number;
  /** Length of the rendered buffer, in sample-frames. */
  length: number;
  /** Sample rate of the rendered buffer, in Hz. */
  sampleRate: number;
}

/**
 * The real dependency: a genuine `OfflineAudioContext`. Structurally
 * satisfies `OfflineAudioContextLike` (a real `AudioBufferSourceNode`/
 * `GainNode`/`AudioParam`/`AudioBuffer` each satisfy their `*Like`
 * counterpart too), so this is a zero-cost identity wrapper, not an adapter
 * that translates calls.
 */
export function createDefaultOfflineAudioContextLike(
  options: DefaultOfflineAudioContextOptions,
): OfflineAudioContextLike {
  return new OfflineAudioContext(options.numberOfChannels, options.length, options.sampleRate);
}
