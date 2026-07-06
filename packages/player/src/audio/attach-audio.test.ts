import {
  type AudioClip,
  type AudioTrack,
  CompositionNotFoundError,
  createComposition,
  createProject,
  type FrameContext,
  type Project,
  type SceneState,
} from "@cadra/core";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "@cadra/renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NowFn, ScheduleFrameFn, Transport } from "../transport.js";
import { createTransport } from "../transport.js";
import { attachAudioToTransport } from "./attach-audio.js";
import type {
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  GainNodeLike,
} from "./audio-context-like.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;

/** A fake AudioParam recording every scheduling call, and tracking `.value` like the real thing. */
function createFakeAudioParam(): AudioParamLike & {
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

/** A fake AudioBufferSourceNode: one-shot, records start/stop/connect/disconnect calls. */
function createFakeSourceNode(): AudioBufferSourceNodeLike & {
  startCalls: Array<{ when?: number; offset?: number; duration?: number }>;
  stopCalls: number[];
  connectedTo: AudioNodeLike[];
  disconnected: boolean;
} {
  const startCalls: Array<{ when?: number; offset?: number; duration?: number }> = [];
  const stopCalls: number[] = [];
  const connectedTo: AudioNodeLike[] = [];
  let disconnected = false;
  return {
    buffer: null,
    startCalls,
    stopCalls,
    connectedTo,
    get disconnected() {
      return disconnected;
    },
    connect(destination) {
      connectedTo.push(destination);
      return destination;
    },
    disconnect() {
      disconnected = true;
    },
    start(when, offset, duration) {
      startCalls.push({ when, offset, duration });
    },
    stop(when) {
      stopCalls.push(when ?? -1);
    },
  };
}

/** A fake GainNode wrapping a fake AudioParam, recording connect/disconnect. */
function createFakeGainNode(): GainNodeLike & {
  connectedTo: AudioNodeLike[];
  disconnected: boolean;
  gainParam: ReturnType<typeof createFakeAudioParam>;
} {
  const connectedTo: AudioNodeLike[] = [];
  let disconnected = false;
  const gainParam = createFakeAudioParam();
  return {
    gain: gainParam,
    gainParam,
    connectedTo,
    get disconnected() {
      return disconnected;
    },
    connect(destination) {
      connectedTo.push(destination);
      return destination;
    },
    disconnect() {
      disconnected = true;
    },
  };
}

/**
 * A fake AudioContext: `currentTime` is directly settable (so tests control
 * "real" audio time exactly), and every created source/gain node is tracked
 * for inspection. Never touches real audio hardware.
 */
function createFakeAudioContext(): AudioContextLike & {
  setCurrentTime: (value: number) => void;
  sourceNodes: ReturnType<typeof createFakeSourceNode>[];
  gainNodes: ReturnType<typeof createFakeGainNode>[];
  destination: AudioNodeLike;
} {
  let currentTime = 0;
  const sourceNodes: ReturnType<typeof createFakeSourceNode>[] = [];
  const gainNodes: ReturnType<typeof createFakeGainNode>[] = [];
  const destination: AudioNodeLike = {
    connect: () => destination,
    disconnect: () => undefined,
  };
  return {
    get currentTime() {
      return currentTime;
    },
    destination,
    sourceNodes,
    gainNodes,
    setCurrentTime(value: number) {
      currentTime = value;
    },
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
  };
}

/** A fake AudioBuffer: just enough identity to tell buffers apart in assertions. */
function createFakeAudioBuffer(label: string): AudioBuffer {
  return { label } as unknown as AudioBuffer;
}

/** Fake Renderer, same shape as transport.test.ts's, touches no GPU. */
function createFakeRenderer(): Renderer & { renderFrame: ReturnType<typeof vi.fn> } {
  return {
    init: vi.fn(async (_target: RenderTarget, _size: RenderSize) => undefined),
    renderFrame: vi.fn((_sceneState: SceneState, _frameContext: FrameContext) => undefined),
    resize: vi.fn((_size: RenderSize) => undefined),
    dispose: vi.fn(() => undefined),
    backend: "webgl2",
    capabilities: {
      backend: "webgl2",
      isFallback: true,
      maxTextureSize: 4096,
    } as RendererCapabilities,
  };
}

/** Manually-driven fake scheduler, identical in spirit to transport.test.ts's. */
function createFakeScheduler(): {
  scheduleFrame: ScheduleFrameFn;
  cancelFrame: (handle: number) => void;
  fireNext: () => void;
} {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  return {
    scheduleFrame: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => {
      pending.delete(handle);
    },
    fireNext: () => {
      const [firstHandle, firstCallback] = [...pending.entries()][0] ?? [];
      if (firstHandle === undefined || firstCallback === undefined) {
        return;
      }
      pending.delete(firstHandle);
      firstCallback();
    },
  };
}

/** Fake wall clock, identical in spirit to transport.test.ts's. */
function createFakeClock(initial = 0): { now: NowFn; advance: (deltaMs: number) => void } {
  let current = initial;
  return {
    now: () => current,
    advance: (deltaMs: number) => {
      current += deltaMs;
    },
  };
}

function makeAudioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "clip-1",
    startFrame: 0,
    durationInFrames: 30,
    assetRef: "track.mp3",
    ...overrides,
  };
}

function buildProject(audioTracks: AudioTrack[]): Project {
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: 640,
    height: 360,
  });
  return createProject({
    id: "p1",
    name: "Project",
    compositions: [{ ...composition, audioTracks }],
  });
}

describe("attachAudioToTransport: construction", () => {
  it("throws CompositionNotFoundError for an unknown compositionId", () => {
    const project = buildProject([]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    expect(() =>
      attachAudioToTransport({
        project,
        compositionId: "does-not-exist",
        transport,
        resolveAudioBuffer: () => undefined,
        audioContext,
      }),
    ).toThrow(CompositionNotFoundError);
  });

  it("immediately schedules whatever is active at the transport's current frame (frame 0), before any play()", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ durationInFrames: 30 })] },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    expect(audioContext.sourceNodes).toHaveLength(1);
    expect(audioContext.sourceNodes[0]?.buffer).toBe(buffer);
  });

  it("does not schedule a clip whose asset is not yet resolvable", () => {
    const project = buildProject([{ id: "track-1", clips: [makeAudioClip()] }]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => undefined,
      audioContext,
    });

    expect(audioContext.sourceNodes).toHaveLength(0);
  });
});

describe("attachAudioToTransport: play() schedules source nodes at the right computed offset/time", () => {
  let project: Project;
  let renderer: ReturnType<typeof createFakeRenderer>;
  let clock: ReturnType<typeof createFakeClock>;
  let scheduler: ReturnType<typeof createFakeScheduler>;
  let transport: Transport;
  let audioContext: ReturnType<typeof createFakeAudioContext>;
  let buffer: AudioBuffer;

  beforeEach(() => {
    buffer = createFakeAudioBuffer("buf-1");
    project = buildProject([
      {
        id: "track-1",
        clips: [makeAudioClip({ startFrame: 10, durationInFrames: 40, trimStartFrames: 15 })],
      },
    ]);
    renderer = createFakeRenderer();
    clock = createFakeClock(0);
    scheduler = createFakeScheduler();
    transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    audioContext = createFakeAudioContext();
  });

  it("schedules nothing at construction (frame 0), since the clip starts at frame 10", () => {
    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    expect(audioContext.sourceNodes).toHaveLength(0);
  });

  it("play() then seeking into the clip's window schedules a source at the correctly trimmed offset", () => {
    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    audioContext.setCurrentTime(5);
    transport.seek(20); // 10 frames into the clip's own window (startFrame 10)

    expect(audioContext.sourceNodes).toHaveLength(1);
    const [source] = audioContext.sourceNodes;
    // localFrame = 20 - 10 = 10; offset = trimStartFrames(15) + localFrame(10) = 25 frames = 25/30s.
    expect(source?.startCalls).toEqual([
      { when: 5, offset: 25 / FPS, duration: (40 - 10) / FPS },
    ]);
  });

  it("play() from before the clip starts, once the tick advances into its window, schedules at offset trimStartFrames (localFrame 0)", () => {
    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    transport.play();
    audioContext.setCurrentTime(10 / FPS); // matches wall-clock advance below
    clock.advance((10 / FPS) * 1000); // exactly frame 10: clip's first active frame
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(10);
    expect(audioContext.sourceNodes).toHaveLength(1);
    const [source] = audioContext.sourceNodes;
    expect(source?.startCalls[0]?.offset).toBeCloseTo(15 / FPS);
    expect(source?.startCalls[0]?.duration).toBeCloseTo(40 / FPS);
  });

  it("connects source -> gain -> destination", () => {
    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    transport.seek(15);

    const [source] = audioContext.sourceNodes;
    const [gain] = audioContext.gainNodes;
    expect(source?.connectedTo).toEqual([gain]);
    expect(gain?.connectedTo).toEqual([audioContext.destination]);
  });
});

describe("attachAudioToTransport: seeking mid-playback stops stale nodes and reschedules at the correct offset", () => {
  it("seeking within the same clip's window discards the stale node and starts a fresh one at the new offset", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    // Construction already scheduled a node for frame 0 (the clip is active
    // from the very start). A seek always hard-resets, unconditionally
    // (never restarted in place: AudioBufferSourceNode is one-shot), even
    // when the clip in question stays active across it, since there is no
    // way to correct an already-playing node's offset other than replacing
    // it, and determining "would this particular node have organically
    // drifted to the wrong offset or not" is exactly the ambiguity a
    // straightforward, always-correct hard reset avoids reasoning about.
    const [initialSource] = audioContext.sourceNodes;

    audioContext.setCurrentTime(2);
    transport.seek(50); // still inside the same clip's [0, 90) window
    expect(initialSource?.stopCalls).toEqual([2]);
    expect(initialSource?.disconnected).toBe(true);

    expect(audioContext.sourceNodes).toHaveLength(2);
    const [, secondSource] = audioContext.sourceNodes;
    // localFrame = 50, trimStartFrames defaults to 0 -> offset 50/30s.
    expect(secondSource?.startCalls[0]?.offset).toBeCloseTo(50 / FPS);
  });

  it("seeking out of a clip's window entirely stops it and schedules nothing new for that track", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 20 })] },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    expect(audioContext.sourceNodes).toHaveLength(1);

    transport.seek(50); // past the clip's [0, 20) window
    const [firstSource] = audioContext.sourceNodes;
    expect(firstSource?.stopCalls.length).toBeGreaterThan(0);

    // No second node was ever started for this now-inactive clip.
    expect(audioContext.sourceNodes).toHaveLength(1);
  });

  it("seeking forward past one clip into a second clip's window swaps which node is playing", () => {
    const bufferA = createFakeAudioBuffer("a");
    const bufferB = createFakeAudioBuffer("b");
    const project = buildProject([
      {
        id: "track-1",
        clips: [
          makeAudioClip({ id: "clip-a", startFrame: 0, durationInFrames: 20, assetRef: "a.mp3" }),
          makeAudioClip({ id: "clip-b", startFrame: 20, durationInFrames: 20, assetRef: "b.mp3" }),
        ],
      },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: (assetRef) => (assetRef === "a.mp3" ? bufferA : bufferB),
      audioContext,
    });
    expect(audioContext.sourceNodes[0]?.buffer).toBe(bufferA);

    transport.seek(25);

    expect(audioContext.sourceNodes[0]?.stopCalls.length).toBeGreaterThan(0);
    expect(audioContext.sourceNodes).toHaveLength(2);
    expect(audioContext.sourceNodes[1]?.buffer).toBe(bufferB);
  });
});

describe("attachAudioToTransport: pause() stops all currently-scheduled nodes", () => {
  it("stops every scheduled node and schedules nothing new", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    transport.play();
    clock.advance(500);
    scheduler.fireNext();
    expect(audioContext.sourceNodes.length).toBeGreaterThan(0);
    const scheduledBeforePause = [...audioContext.sourceNodes];

    transport.pause();

    for (const source of scheduledBeforePause) {
      expect(source.stopCalls.length).toBeGreaterThan(0);
    }
    // pause() must not have scheduled any further node.
    expect(audioContext.sourceNodes).toHaveLength(scheduledBeforePause.length);
  });

  it("re-play() after pause reschedules fresh nodes for whatever is active at the resumed frame", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    transport.play();
    clock.advance(300); // 9 frames
    scheduler.fireNext();
    transport.pause();
    const nodeCountAfterPause = audioContext.sourceNodes.length;

    transport.play();

    expect(audioContext.sourceNodes.length).toBeGreaterThan(nodeCountAfterPause);
    const newest = audioContext.sourceNodes.at(-1);
    // Resumed at currentFrame 9 (frozen by pause), localFrame 9, trimStartFrames 0.
    expect(newest?.startCalls[0]?.offset).toBeCloseTo(9 / FPS);
  });
});

describe("attachAudioToTransport: ordinary tick-driven advancement (no seek/pause/play involved)", () => {
  it("a clip that ends mid-playback is stopped exactly when its window ends, without an explicit seek", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 10 })] },
    ]);
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    expect(audioContext.sourceNodes).toHaveLength(1);
    const [source] = audioContext.sourceNodes;

    transport.play();
    clock.advance(1000); // far past frame 10: clip's window [0, 10) has ended
    scheduler.fireNext();

    expect(source?.stopCalls.length).toBeGreaterThan(0);
    // No new node was started for the now-ended clip.
    expect(audioContext.sourceNodes).toHaveLength(1);
  });

  it("a clip that starts mid-playback is scheduled exactly when its window opens, without an explicit seek", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 30, durationInFrames: 30 })] },
    ]);
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    expect(audioContext.sourceNodes).toHaveLength(0);

    transport.play();
    clock.advance(1000); // 30 frames: exactly the clip's startFrame
    scheduler.fireNext();

    expect(transport.currentFrame).toBe(30);
    expect(audioContext.sourceNodes).toHaveLength(1);
  });

  it("does not restart an already-correctly-playing clip on every ordinary tick", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const clock = createFakeClock(0);
    const scheduler = createFakeScheduler();
    const transport = createTransport({
      project,
      compositionId: "comp-1",
      renderer,
      now: clock.now,
      scheduleFrame: scheduler.scheduleFrame,
      cancelFrame: scheduler.cancelFrame,
    });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    expect(audioContext.sourceNodes).toHaveLength(1);

    transport.play();
    for (let i = 0; i < 10; i += 1) {
      clock.advance(100);
      scheduler.fireNext();
    }

    // Still the exact same single node the whole time: never stopped, never replaced.
    expect(audioContext.sourceNodes).toHaveLength(1);
    expect(audioContext.sourceNodes[0]?.stopCalls).toHaveLength(0);
  });
});

describe("attachAudioToTransport: gain scheduling reflects fade envelopes", () => {
  it("schedules an initial setValueAtTime pinning gain 0 at the very start of a fadeIn", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      {
        id: "track-1",
        clips: [
          makeAudioClip({
            startFrame: 0,
            durationInFrames: 30,
            gain: 1,
            fadeIn: { durationInFrames: 10 },
          }),
        ],
      },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    const [gain] = audioContext.gainNodes;
    // cancelScheduledValues always precedes the pin (clearing any stale
    // automation curve first); the pin itself is the setValueAtTime call.
    const pinCall = gain?.gainParam.calls.find((call) => call.kind === "setValueAtTime");
    expect(pinCall).toEqual({ kind: "setValueAtTime", value: 0, time: 0 });
  });

  it("schedules a ramp up to full gain at the audio-time corresponding to fadeIn's end frame", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      {
        id: "track-1",
        clips: [
          makeAudioClip({
            startFrame: 0,
            durationInFrames: 30,
            gain: 1,
            fadeIn: { durationInFrames: 10 },
          }),
        ],
      },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();
    audioContext.setCurrentTime(2); // schedule starting from a nonzero context time

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    const [gain] = audioContext.gainNodes;
    const rampCall = gain?.gainParam.calls.find((call) => call.kind === "linearRampToValueAtTime");
    expect(rampCall).toEqual({
      kind: "linearRampToValueAtTime",
      value: 1,
      time: 2 + 10 / FPS,
    });
  });

  it("re-pins gain at the correct mid-fade value when seeking into the middle of a fadeOut", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      {
        id: "track-1",
        clips: [
          makeAudioClip({
            startFrame: 0,
            durationInFrames: 30,
            gain: 1,
            fadeOut: { durationInFrames: 10 },
          }),
        ],
      },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    // Seek to frame 25: fadeOut spans [20, 30), so this is its midpoint (gain 0.5).
    audioContext.setCurrentTime(3);
    transport.seek(25);

    const [, gainAfterSeek] = audioContext.gainNodes;
    const pinCall = gainAfterSeek?.gainParam.calls.find((call) => call.kind === "setValueAtTime");
    expect(pinCall).toEqual({ kind: "setValueAtTime", value: 0.5, time: 3 });
  });

  it("schedules gain at a constant clip.gain (a single setValueAtTime, no ramps) when there are no fades", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      {
        id: "track-1",
        clips: [makeAudioClip({ startFrame: 0, durationInFrames: 30, gain: 0.6 })],
      },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    const [gain] = audioContext.gainNodes;
    expect(gain?.gainParam.calls).toEqual([
      { kind: "cancelScheduledValues", time: 0 },
      { kind: "setValueAtTime", value: 0.6, time: 0 },
    ]);
  });
});

describe("attachAudioToTransport: dispose", () => {
  it("stops every currently-scheduled node", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    const sync = attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    const [source] = audioContext.sourceNodes;

    sync.dispose();

    expect(source?.stopCalls.length).toBeGreaterThan(0);
  });

  it("restores the transport's original play/pause/seek methods", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();
    const originalSeek = transport.seek;

    const sync = attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    expect(transport.seek).not.toBe(originalSeek);

    sync.dispose();

    expect(transport.seek).toBe(originalSeek);
  });

  it("is idempotent: calling dispose() a second time does not throw", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    const sync = attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });

    sync.dispose();
    expect(() => sync.dispose()).not.toThrow();
  });

  it("a seek() after dispose() no longer triggers any audio scheduling", () => {
    const buffer = createFakeAudioBuffer("buf-1");
    const project = buildProject([
      { id: "track-1", clips: [makeAudioClip({ startFrame: 0, durationInFrames: 90 })] },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    const sync = attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => buffer,
      audioContext,
    });
    sync.dispose();
    const nodeCountAfterDispose = audioContext.sourceNodes.length;

    transport.seek(50);

    expect(audioContext.sourceNodes).toHaveLength(nodeCountAfterDispose);
  });
});

describe("attachAudioToTransport: multiple simultaneous clips across tracks", () => {
  it("schedules one node per active clip across multiple tracks at once", () => {
    const bufferA = createFakeAudioBuffer("a");
    const bufferB = createFakeAudioBuffer("b");
    const project = buildProject([
      {
        id: "track-1",
        clips: [makeAudioClip({ id: "clip-a", startFrame: 0, durationInFrames: 90, assetRef: "a.mp3" })],
      },
      {
        id: "track-2",
        clips: [makeAudioClip({ id: "clip-b", startFrame: 0, durationInFrames: 90, assetRef: "b.mp3" })],
      },
    ]);
    const renderer = createFakeRenderer();
    const transport = createTransport({ project, compositionId: "comp-1", renderer });
    const audioContext = createFakeAudioContext();

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: (assetRef) => (assetRef === "a.mp3" ? bufferA : bufferB),
      audioContext,
    });

    expect(audioContext.sourceNodes).toHaveLength(2);
    const buffers = audioContext.sourceNodes.map((node) => node.buffer);
    expect(buffers).toContain(bufferA);
    expect(buffers).toContain(bufferB);
  });
});
