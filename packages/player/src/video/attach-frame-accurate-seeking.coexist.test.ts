import {
  type AssetKind,
  type AudioClip,
  type AudioTrack,
  createComposition,
  createProject,
  type FrameContext,
  Image,
  type Project,
  type SceneState,
  Sequence,
} from "@cadra/core";
import type { Renderer, RendererCapabilities, RenderSize, RenderTarget } from "@cadra/renderer";
import { describe, expect, it, vi } from "vitest";

import { attachAudioToTransport } from "../audio/attach-audio.js";
import type {
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  GainNodeLike,
} from "../audio/audio-context-like.js";
import { createTransport } from "../transport.js";
import { attachFrameAccurateSeeking } from "./attach-frame-accurate-seeking.js";
import { createVideoFrameReadyCheck } from "./create-video-frame-ready-check.js";
import { createDecodeQueue, type DecodeVideoFrameFn } from "./decode-video-frame.js";
import { createVideoReadinessCache } from "./video-readiness.js";

const FPS = 30;
const DURATION_IN_FRAMES = 90;

function assetKindOf(assetRef: string): AssetKind | undefined {
  return assetRef === "video-asset" ? "video" : undefined;
}

/** A fixed fake AudioParam: records nothing, just satisfies the interface. */
function createFakeAudioParam(): AudioParamLike {
  return {
    value: 0,
    setValueAtTime(value) {
      this.value = value;
      return this;
    },
    linearRampToValueAtTime(value) {
      this.value = value;
      return this;
    },
    cancelScheduledValues() {
      return this;
    },
  };
}

function createFakeSourceNode(): AudioBufferSourceNodeLike {
  return {
    buffer: null,
    connect(destination) {
      return destination;
    },
    disconnect() {
      // no-op fake
    },
    start() {
      // no-op fake
    },
    stop() {
      // no-op fake
    },
  };
}

function createFakeGainNode(): GainNodeLike {
  return {
    gain: createFakeAudioParam(),
    connect(destination) {
      return destination;
    },
    disconnect() {
      // no-op fake
    },
  };
}

function createFakeAudioContext(): AudioContextLike {
  const destination: AudioNodeLike = {
    connect: () => destination,
    disconnect: () => undefined,
  };
  return {
    currentTime: 0,
    destination,
    createBufferSource: () => createFakeSourceNode(),
    createGain: () => createFakeGainNode(),
  };
}

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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeAudioClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "audio-clip-1",
    startFrame: 0,
    durationInFrames: DURATION_IN_FRAMES,
    assetRef: "track.mp3",
    ...overrides,
  };
}

/** A project with both a video-backed image track and an audio track, so both Phase 16 and Phase 17's attachments have something real to react to. */
function buildProjectWithVideoAndAudio(audioTracks: AudioTrack[]): Project {
  const composition = createComposition({
    id: "comp-1",
    name: "Main",
    fps: FPS,
    durationInFrames: DURATION_IN_FRAMES,
    width: 640,
    height: 360,
    tracks: [
      {
        id: "track-1",
        clips: [
          Sequence({
            id: "clip-1",
            from: 0,
            durationInFrames: DURATION_IN_FRAMES,
            content: Image({ id: "video-node", assetRef: "video-asset" }),
          }),
        ],
      },
    ],
  });
  return createProject({
    id: "p1",
    name: "Project",
    compositions: [{ ...composition, audioTracks }],
  });
}

describe("attachFrameAccurateSeeking and attachAudioToTransport coexisting on one Transport", () => {
  it("both attach cleanly to the same transport without throwing", () => {
    const project = buildProjectWithVideoAndAudio([{ id: "audio-track-1", clips: [makeAudioClip()] }]);
    const renderer = createFakeRenderer();
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 0); // frame 0 already ready, so construction's initial render is not gated
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });
    const transport = createTransport({ project, compositionId: "comp-1", renderer, isFrameReady });
    const audioContext = createFakeAudioContext();
    const audioBuffer = { label: "buf" } as unknown as AudioBuffer;

    expect(() => {
      const audioSync = attachAudioToTransport({
        project,
        compositionId: "comp-1",
        transport,
        resolveAudioBuffer: () => audioBuffer,
        audioContext,
      });
      const decodeQueue = createDecodeQueue(
        (() => Promise.resolve()) as DecodeVideoFrameFn,
        cache,
      );
      const seeking = attachFrameAccurateSeeking(transport, {
        project,
        compositionId: "comp-1",
        cache,
        assetKindOf,
        decodeQueue,
      });
      audioSync.dispose();
      seeking.dispose();
    }).not.toThrow();
  });

  it("a video-gated seek delays audio rescheduling exactly as long as it delays the frame render, then both settle together", async () => {
    const project = buildProjectWithVideoAndAudio([{ id: "audio-track-1", clips: [makeAudioClip()] }]);
    const renderer = createFakeRenderer();
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 0);
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });
    const transport = createTransport({ project, compositionId: "comp-1", renderer, isFrameReady });
    const audioContext = createFakeAudioContext();
    const audioBuffer = { label: "buf" } as unknown as AudioBuffer;
    const audioContextSpy = vi.spyOn(audioContext, "createBufferSource");

    attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => audioBuffer,
      audioContext,
    });
    audioContextSpy.mockClear();

    let resolveDecode: (() => void) | undefined;
    const decodeQueue = createDecodeQueue(() => {
      return new Promise<void>((resolve) => {
        resolveDecode = resolve;
      });
    }, cache);
    attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });

    transport.seek(40);

    // Video not ready: currentFrame unchanged, and (since attachAudioToTransport
    // only reacts to a completed transport.seek()/frameChanged) no new audio
    // node has been scheduled for frame 40 yet either.
    expect(transport.currentFrame).toBe(0);
    expect(audioContextSpy).not.toHaveBeenCalled();

    resolveDecode?.();
    await flushMicrotasks();

    expect(transport.currentFrame).toBe(40);
    // Audio's wrapped seek ran as part of the original seek() completing,
    // rescheduling from the new frame: at least one new source node exists
    // for the still-active audio clip at frame 40.
    expect(audioContextSpy).toHaveBeenCalled();
  });

  it("wraps in either construction order (audio first, seeking second, or vice versa) without one clobbering the other's seek wrapper", () => {
    const project = buildProjectWithVideoAndAudio([{ id: "audio-track-1", clips: [makeAudioClip()] }]);
    const renderer = createFakeRenderer();
    const cache = createVideoReadinessCache();
    cache.markReady("video-asset", 25);
    const isFrameReady = createVideoFrameReadyCheck({
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
    });
    const transport = createTransport({ project, compositionId: "comp-1", renderer, isFrameReady });
    const audioContext = createFakeAudioContext();
    const audioBuffer = { label: "buf" } as unknown as AudioBuffer;
    const decodeQueue = createDecodeQueue((() => Promise.resolve()) as DecodeVideoFrameFn, cache);

    // Seeking attaches first, audio second: audio's wrapper must still call
    // through to seeking's wrapper (not the raw original seek), and vice
    // versa, since each only saves whatever transport.seek currently is at
    // the moment it attaches.
    const seeking = attachFrameAccurateSeeking(transport, {
      project,
      compositionId: "comp-1",
      cache,
      assetKindOf,
      decodeQueue,
    });
    const audioSync = attachAudioToTransport({
      project,
      compositionId: "comp-1",
      transport,
      resolveAudioBuffer: () => audioBuffer,
      audioContext,
    });

    transport.seek(25);
    expect(transport.currentFrame).toBe(25);

    audioSync.dispose();
    seeking.dispose();
  });
});
