import { describe, expect, it } from "vitest";

import type { CompositionFog, CompositionPhysics, PhysicsConstraintConfig } from "../scene-graph/timeline.js";
import { createComposition } from "./composition.js";

describe("createComposition", () => {
  it("defaults tracks to an empty array when omitted", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
    });

    expect(composition).toEqual({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      tracks: [],
    });
  });

  it("preserves tracks when provided", () => {
    const tracks = [{ id: "track-1", clips: [] }];

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 24,
      durationInFrames: 100,
      width: 1280,
      height: 720,
      tracks,
    });

    expect(composition.tracks).toEqual(tracks);
  });

  it("omits activeCameraTrack, audioTracks, colorGrading, environment, fog, shadowQuality, postProcessing, renderMode, pathTracing, physics, and physicsConstraints entirely when not provided", () => {
    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
    });

    expect("activeCameraTrack" in composition).toBe(false);
    expect("audioTracks" in composition).toBe(false);
    expect("colorGrading" in composition).toBe(false);
    expect("environment" in composition).toBe(false);
    expect("fog" in composition).toBe(false);
    expect("shadowQuality" in composition).toBe(false);
    expect("postProcessing" in composition).toBe(false);
    expect("renderMode" in composition).toBe(false);
    expect("pathTracing" in composition).toBe(false);
    expect("physics" in composition).toBe(false);
    expect("physicsConstraints" in composition).toBe(false);
  });

  it("preserves activeCameraTrack when provided", () => {
    const activeCameraTrack = [{ startFrame: 0, durationInFrames: 30, cameraNodeId: "cam-1" }];

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      activeCameraTrack,
    });

    expect(composition.activeCameraTrack).toEqual(activeCameraTrack);
  });

  it("preserves audioTracks when provided", () => {
    const audioTracks = [{ id: "audio-1", clips: [] }];

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      audioTracks,
    });

    expect(composition.audioTracks).toEqual(audioTracks);
  });

  it("preserves colorGrading when provided", () => {
    const colorGrading = { exposureStops: 0.5, whiteBalanceTemperatureK: 5000, whiteBalanceTint: 0.1 };

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      colorGrading,
    });

    expect(composition.colorGrading).toEqual(colorGrading);
  });

  it("preserves environment when provided", () => {
    const environment = { envMapRef: "studio", rotation: Math.PI / 2, intensity: 1.5, showBackground: true };

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      environment,
    });

    expect(composition.environment).toEqual(environment);
  });

  it("preserves fog when provided", () => {
    const fog: CompositionFog = { type: "linear", color: [0.6, 0.6, 0.65, 1], near: 5, far: 100 };

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      fog,
    });

    expect(composition.fog).toEqual(fog);
  });

  it("preserves shadowQuality when provided", () => {
    const shadowQuality = {
      tier: "final" as const,
      cascadedShadows: { cascades: 4, maxFar: 500 },
      ambientOcclusion: { radius: 1.5, intensity: 0.8 },
      contactShadows: { groundY: 0, opacity: 0.6, radius: 3 },
    };

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      shadowQuality,
    });

    expect(composition.shadowQuality).toEqual(shadowQuality);
  });

  it("preserves postProcessing when provided", () => {
    const postProcessing = { tier: "final" as const, effects: [{ type: "sharpen" as const, amount: 0.6 }] };

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      postProcessing,
    });

    expect(composition.postProcessing).toEqual(postProcessing);
  });

  it("preserves renderMode and pathTracing when provided", () => {
    const pathTracing = { tier: "final" as const, samples: 256, bounces: 6 };

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      renderMode: "pathTraced",
      pathTracing,
    });

    expect(composition.renderMode).toBe("pathTraced");
    expect(composition.pathTracing).toEqual(pathTracing);
  });

  it("preserves physics and physicsConstraints when provided", () => {
    const physics: CompositionPhysics = { gravity: [0, -9.81, 0], substeps: 4 };
    const physicsConstraints: PhysicsConstraintConfig[] = [
      {
        id: "joint-1",
        type: "revolute",
        bodyA: "body-a",
        bodyB: "body-b",
        anchorA: [0, 0, 0],
        anchorB: [0, 1, 0],
        axis: [1, 0, 0],
      },
    ];

    const composition = createComposition({
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      physics,
      physicsConstraints,
    });

    expect(composition.physics).toEqual(physics);
    expect(composition.physicsConstraints).toEqual(physicsConstraints);
  });
});
