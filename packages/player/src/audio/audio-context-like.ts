/**
 * The narrow subset of the real Web Audio API this module actually drives:
 * `AudioContext.currentTime`, node creation (`createBufferSource`,
 * `createGain`), `destination`, connecting nodes, and starting/stopping a
 * source. `AudioContext`/`AudioBufferSourceNode`/`GainNode`/`AudioParam` do
 * not exist in this headless Node/Vitest environment, so every real
 * construct this module touches is expressed as one of these structural
 * interfaces and injected, exactly like `ThreeRendererDependencies` in
 * `@cadra/renderer` keeps every real GPU/Three.js construct swappable.
 *
 * Each `*Like` interface intentionally covers only the members this module
 * calls, not the full real interface (e.g. real `AudioParam` also has
 * `exponentialRampToValueAtTime`, `automationRate`, etc., unused here): a
 * real `AudioParam`/`GainNode`/`AudioBufferSourceNode`/`AudioContext`
 * satisfies its `*Like` counterpart structurally, so `defaultAudioContextLike`
 * can wrap a real `AudioContext` with zero adaptation, while a test fake only
 * has to implement this smaller surface.
 */

/** The gain/`.value`-bearing scheduling surface this module needs from a real `AudioParam`. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

/** Anything a source or gain node can `connect()` to: another node, or the context's destination. */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): unknown;
}

/** The playback-control surface this module needs from a real `GainNode`. */
export interface GainNodeLike extends AudioNodeLike {
  gain: AudioParamLike;
}

/**
 * The playback-control surface this module needs from a real
 * `AudioBufferSourceNode`. One-shot, exactly like the real thing: once
 * `stop()` is called (or it finishes naturally), it can never be restarted,
 * which is exactly why this module always discards and replaces a node
 * rather than reusing one across a seek.
 */
export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBuffer | null;
  start(when?: number, offset?: number, duration?: number): unknown;
  stop(when?: number): unknown;
}

/**
 * The subset of a real `AudioContext` this module needs: an ever-increasing
 * clock (`currentTime`), a final output node (`destination`), and factories
 * for the two node kinds it schedules.
 */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createGain(): GainNodeLike;
}

/**
 * The real dependency: a genuine `AudioContext`. Structurally satisfies
 * `AudioContextLike` (a real `AudioBufferSourceNode`/`GainNode`/`AudioParam`
 * each satisfy their `*Like` counterpart too), so this is a zero-cost
 * identity wrapper, not an adapter that translates calls.
 */
export function createDefaultAudioContextLike(): AudioContextLike {
  return new AudioContext();
}
