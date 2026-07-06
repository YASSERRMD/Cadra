import type { AudioMixdownDescription, AudioMixdownSegment } from "@cadra/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AudioBufferLike,
  OfflineAudioBufferSourceNodeLike,
  OfflineAudioContextLike,
  OfflineAudioNodeLike,
  OfflineAudioParamLike,
  OfflineGainNodeLike,
} from "./offline-audio-context-like.js";
import { renderAudioMixdown } from "./render-audio-mixdown.js";

const FPS = 30;

/** A fake AudioParam recording every scheduling call. Mirrors attach-audio.test.ts's own fake. */
function createFakeAudioParam(): OfflineAudioParamLike & {
  calls: Array<
    | { kind: "setValueAtTime"; value: number; time: number }
    | { kind: "linearRampToValueAtTime"; value: number; time: number }
    | { kind: "cancelScheduledValues"; time: number }
  >;
} {
  const calls: ReturnType<typeof createFakeAudioParam>["calls"] = [];
  return {
    value: 0,
    calls,
    setValueAtTime(value, time) {
      calls.push({ kind: "setValueAtTime", value, time });
      return this;
    },
    linearRampToValueAtTime(value, time) {
      calls.push({ kind: "linearRampToValueAtTime", value, time });
      return this;
    },
    cancelScheduledValues(time) {
      calls.push({ kind: "cancelScheduledValues", time });
      return this;
    },
  };
}

/** A fake AudioBufferSourceNode: records start/stop/connect/disconnect calls. */
function createFakeSourceNode(): OfflineAudioBufferSourceNodeLike & {
  startCalls: Array<{ when?: number; offset?: number; duration?: number }>;
  connectedTo: OfflineAudioNodeLike[];
} {
  const startCalls: Array<{ when?: number; offset?: number; duration?: number }> = [];
  const connectedTo: OfflineAudioNodeLike[] = [];
  return {
    buffer: null,
    startCalls,
    connectedTo,
    connect(destination) {
      connectedTo.push(destination);
      return destination;
    },
    disconnect() {
      return undefined;
    },
    start(when, offset, duration) {
      startCalls.push({ when, offset, duration });
    },
    stop() {
      return undefined;
    },
  };
}

/** A fake GainNode wrapping a fake AudioParam. */
function createFakeGainNode(): OfflineGainNodeLike & {
  connectedTo: OfflineAudioNodeLike[];
  gainParam: ReturnType<typeof createFakeAudioParam>;
} {
  const connectedTo: OfflineAudioNodeLike[] = [];
  const gainParam = createFakeAudioParam();
  return {
    gain: gainParam,
    gainParam,
    connectedTo,
    connect(destination) {
      connectedTo.push(destination);
      return destination;
    },
    disconnect() {
      return undefined;
    },
  };
}

/**
 * A fake AudioBuffer: just enough identity to tell buffers apart in
 * assertions. `label` is stored on the returned object purely for
 * readability at a debugger breakpoint (mirroring
 * `attach-audio.test.ts`'s own `createFakeAudioBuffer`); every assertion in
 * this file distinguishes fakes by reference (`toBe`/`toContain`), not by
 * reading `label` back out.
 */
function createFakeAudioBuffer(label: string): AudioBufferLike {
  return {
    label,
    duration: 0,
    length: 0,
    numberOfChannels: 2,
    sampleRate: 48_000,
    getChannelData: () => new Float32Array(0),
    // Cast is required: this fake only implements AudioBufferLike's own
    // narrow surface, plus the `label` field above, which is not itself
    // part of AudioBufferLike.
  } as unknown as AudioBufferLike & { label: string };
}

/**
 * A fake OfflineAudioContext: every created source/gain node is tracked for
 * inspection, and `startRendering()` resolves to a fixed fake
 * `AudioBufferLike` (or a deferred one set up by the test).
 */
function createFakeOfflineAudioContext(renderedBuffer: AudioBufferLike): OfflineAudioContextLike & {
  sourceNodes: ReturnType<typeof createFakeSourceNode>[];
  gainNodes: ReturnType<typeof createFakeGainNode>[];
  destination: OfflineAudioNodeLike;
  startRenderingCallCount: () => number;
} {
  const sourceNodes: ReturnType<typeof createFakeSourceNode>[] = [];
  const gainNodes: ReturnType<typeof createFakeGainNode>[] = [];
  const destination: OfflineAudioNodeLike = {
    connect: () => destination,
    disconnect: () => undefined,
  };
  let startRenderingCalls = 0;
  return {
    length: 0,
    sampleRate: 48_000,
    destination,
    sourceNodes,
    gainNodes,
    startRenderingCallCount: () => startRenderingCalls,
    createBufferSource() {
      const node = createFakeSourceNode();
      sourceNodes.push(node);
      return node;
    },
    createGain() {
      const node = createFakeGainNode();
      gainNodes.push(node);
      return node;
    },
    startRendering: async () => {
      startRenderingCalls += 1;
      return renderedBuffer;
    },
  };
}

function makeSegment(overrides: Partial<AudioMixdownSegment> = {}): AudioMixdownSegment {
  return {
    trackId: "track-1",
    clipId: "clip-1",
    assetRef: "track.mp3",
    startFrame: 0,
    durationInFrames: 30,
    trimStartFrames: 0,
    gain: 1,
    ...overrides,
  };
}

function makeMixdown(segments: AudioMixdownSegment[]): AudioMixdownDescription {
  return { compositionId: "comp-1", segments };
}

describe("renderAudioMixdown: basic scheduling", () => {
  it("schedules one source+gain node pair per segment, connected source -> gain -> destination", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([makeSegment()]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    expect(context.sourceNodes).toHaveLength(1);
    expect(context.gainNodes).toHaveLength(1);
    const [source] = context.sourceNodes;
    const [gain] = context.gainNodes;
    expect(source?.buffer).toBe(buffer);
    expect(source?.connectedTo).toEqual([gain]);
    expect(gain?.connectedTo).toEqual([context.destination]);
  });

  it("schedules the source at startFrame/fps seconds, with duration durationInFrames/fps", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([
      makeSegment({ startFrame: 15, durationInFrames: 30, trimStartFrames: 0 }),
    ]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    const [source] = context.sourceNodes;
    expect(source?.startCalls).toEqual([{ when: 15 / FPS, offset: 0, duration: 30 / FPS }]);
  });

  it("computes the buffer offset from trimStartFrames", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([
      makeSegment({ startFrame: 0, durationInFrames: 40, trimStartFrames: 15 }),
    ]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    const [source] = context.sourceNodes;
    expect(source?.startCalls[0]?.offset).toBeCloseTo(15 / FPS);
  });

  it("schedules multiple segments across multiple tracks, each with its own node pair", async () => {
    const bufferA = createFakeAudioBuffer("a");
    const bufferB = createFakeAudioBuffer("b");
    const context = createFakeOfflineAudioContext(bufferA);
    const mixdown = makeMixdown([
      makeSegment({ clipId: "clip-a", trackId: "track-1", assetRef: "a.mp3", startFrame: 0 }),
      makeSegment({ clipId: "clip-b", trackId: "track-2", assetRef: "b.mp3", startFrame: 20 }),
    ]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: (assetRef) => (assetRef === "a.mp3" ? bufferA : bufferB),
      offlineAudioContext: context,
    });

    expect(context.sourceNodes).toHaveLength(2);
    const buffers = context.sourceNodes.map((node) => node.buffer);
    expect(buffers).toContain(bufferA);
    expect(buffers).toContain(bufferB);
  });

  it("does not schedule a segment whose asset cannot be resolved", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([makeSegment()]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => undefined,
      offlineAudioContext: context,
    });

    expect(context.sourceNodes).toHaveLength(0);
  });

  it("schedules nothing for an empty mixdown (a composition with no audioTracks) but still renders", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([]);

    const result = await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    expect(context.sourceNodes).toHaveLength(0);
    expect(context.startRenderingCallCount()).toBe(1);
    expect(result).toBe(buffer);
  });
});

describe("renderAudioMixdown: gain envelope scheduling", () => {
  it("pins gain 0 at the start of a fadeIn", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([
      makeSegment({ startFrame: 10, durationInFrames: 30, gain: 1, fadeIn: { durationInFrames: 10 } }),
    ]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    const [gain] = context.gainNodes;
    const pinCall = gain?.gainParam.calls.find((call) => call.kind === "setValueAtTime");
    expect(pinCall).toEqual({ kind: "setValueAtTime", value: 0, time: 10 / FPS });
  });

  it("ramps up to full gain at the audio-time corresponding to fadeIn's end frame, offset by the segment's own start", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([
      makeSegment({ startFrame: 10, durationInFrames: 30, gain: 1, fadeIn: { durationInFrames: 10 } }),
    ]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    const [gain] = context.gainNodes;
    const rampCall = gain?.gainParam.calls.find((call) => call.kind === "linearRampToValueAtTime");
    expect(rampCall).toEqual({
      kind: "linearRampToValueAtTime",
      value: 1,
      time: 10 / FPS + 10 / FPS,
    });
  });

  it("schedules a constant gain (single setValueAtTime, no ramps) when there are no fades", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([makeSegment({ startFrame: 0, durationInFrames: 30, gain: 0.6 })]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    const [gain] = context.gainNodes;
    expect(gain?.gainParam.calls).toEqual([
      { kind: "cancelScheduledValues", time: 0 },
      { kind: "setValueAtTime", value: 0.6, time: 0 },
    ]);
  });

  it("ramps down to 0 at the end of a fadeOut", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const context = createFakeOfflineAudioContext(buffer);
    const mixdown = makeMixdown([
      makeSegment({ startFrame: 0, durationInFrames: 30, gain: 1, fadeOut: { durationInFrames: 10 } }),
    ]);

    await renderAudioMixdown({
      mixdown,
      fps: FPS,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    const [gain] = context.gainNodes;
    const rampCalls = gain?.gainParam.calls.filter((call) => call.kind === "linearRampToValueAtTime");
    expect(rampCalls?.at(-1)).toEqual({
      kind: "linearRampToValueAtTime",
      value: 0,
      time: 30 / FPS,
    });
  });
});

describe("renderAudioMixdown: full-composition alignment", () => {
  it("schedules a segment starting well after frame 0 at its own absolute position, proving the render is not clipped to the mixdown's own content range", async () => {
    const buffer = createFakeAudioBuffer("buf-1");
    // A mixdown whose only clip starts at frame 60 (well after frame 0),
    // in a 90-frame (3 second) composition: the segment must still be
    // scheduled at its own absolute position (2 seconds in), not
    // repositioned as though the render only spanned its own content.
    const mixdown = makeMixdown([makeSegment({ startFrame: 60, durationInFrames: 30 })]);
    const fps = 30;
    const context = createFakeOfflineAudioContext(buffer);

    await renderAudioMixdown({
      mixdown,
      fps,
      durationInFrames: 90,
      resolveAudioBuffer: () => buffer,
      offlineAudioContext: context,
    });

    const [source] = context.sourceNodes;
    expect(source?.startCalls[0]?.when).toBeCloseTo(60 / fps);
  });

  describe("with the default OfflineAudioContext factory", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("constructs the context sized to exactly durationInFrames/fps seconds at the given sample rate, not the mixdown's own content range", async () => {
      const constructorCalls: Array<{
        numberOfChannels: number;
        length: number;
        sampleRate: number;
      }> = [];
      const buffer = createFakeAudioBuffer("buf-1");

      class FakeOfflineAudioContext {
        constructor(numberOfChannels: number, length: number, sampleRate: number) {
          constructorCalls.push({ numberOfChannels, length, sampleRate });
        }
        createBufferSource(): OfflineAudioBufferSourceNodeLike {
          return createFakeSourceNode();
        }
        createGain(): OfflineGainNodeLike {
          return createFakeGainNode();
        }
        get destination(): OfflineAudioNodeLike {
          return { connect: () => this.destination, disconnect: () => undefined };
        }
        async startRendering(): Promise<AudioBufferLike> {
          return buffer;
        }
      }
      vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);

      // A mixdown whose only clip starts at frame 60 in a 90-frame, 30fps
      // (3 second) composition rendered at 48kHz stereo: the constructed
      // context's length must reflect the full 3-second span
      // (90 / 30 * 48000 = 144000 sample-frames), not merely enough to
      // cover the clip's own 1-second content starting at frame 60.
      const mixdown = makeMixdown([makeSegment({ startFrame: 60, durationInFrames: 30 })]);

      await renderAudioMixdown({
        mixdown,
        fps: 30,
        durationInFrames: 90,
        sampleRate: 48_000,
        numberOfChannels: 2,
        resolveAudioBuffer: () => buffer,
      });

      expect(constructorCalls).toEqual([{ numberOfChannels: 2, length: 144_000, sampleRate: 48_000 }]);
    });
  });
});
