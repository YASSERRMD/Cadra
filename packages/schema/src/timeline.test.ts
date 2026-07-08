import { createIdentityTransform } from "@cadra/core";
import { describe, expect, it } from "vitest";

import {
  activeCameraEntrySchema,
  audioClipSchema,
  audioFadeEnvelopeSchema,
  audioTrackSchema,
  clipSchema,
  compositionSchema,
  postEffectConfigSchema,
  projectSchema,
  trackSchema,
  transitionSchema,
} from "./timeline.js";

function sampleNode() {
  return {
    id: "node-1",
    kind: "group" as const,
    transform: createIdentityTransform(),
    visible: true,
    children: [],
  };
}

describe("transitionSchema", () => {
  it("accepts a fade transition with no direction", () => {
    const result = transitionSchema.safeParse({ type: "fade", durationInFrames: 15 });
    expect(result.success).toBe(true);
  });

  it("accepts a crossDissolve transition with no direction", () => {
    const result = transitionSchema.safeParse({ type: "crossDissolve", durationInFrames: 20 });
    expect(result.success).toBe(true);
  });

  it("accepts a wipe transition with a direction", () => {
    const result = transitionSchema.safeParse({
      type: "wipe",
      durationInFrames: 10,
      direction: "left",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a wipe transition missing direction", () => {
    const result = transitionSchema.safeParse({ type: "wipe", durationInFrames: 10 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) => candidate.path.join(".") === "direction",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/requires a 'direction'/);
    }
  });

  it("rejects a fade transition with a direction present", () => {
    const result = transitionSchema.safeParse({
      type: "fade",
      durationInFrames: 10,
      direction: "up",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find(
        (candidate) => candidate.path.join(".") === "direction",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/only meaningful for a 'wipe' transition/);
    }
  });

  it("rejects a crossDissolve transition with a direction present", () => {
    const result = transitionSchema.safeParse({
      type: "crossDissolve",
      durationInFrames: 10,
      direction: "down",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive durationInFrames", () => {
    expect(transitionSchema.safeParse({ type: "fade", durationInFrames: 0 }).success).toBe(false);
    expect(transitionSchema.safeParse({ type: "fade", durationInFrames: -5 }).success).toBe(false);
  });

  it("rejects an unrecognized transition type", () => {
    const result = transitionSchema.safeParse({ type: "sparkle", durationInFrames: 10 });
    expect(result.success).toBe(false);
  });
});

describe("postEffectConfigSchema", () => {
  it("accepts a sharpen effect with an amount", () => {
    const result = postEffectConfigSchema.safeParse({ type: "sharpen", amount: 0.75 });
    expect(result.success).toBe(true);
  });

  it("accepts a sharpen effect with no amount (defaults elsewhere)", () => {
    const result = postEffectConfigSchema.safeParse({ type: "sharpen" });
    expect(result.success).toBe(true);
  });

  it("rejects an unrecognized effect type", () => {
    const result = postEffectConfigSchema.safeParse({ type: "sparkle", amount: 0.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a sharpen effect with an extra, unrecognized field", () => {
    const result = postEffectConfigSchema.safeParse({ type: "sharpen", amount: 0.5, radius: 3 });
    expect(result.success).toBe(false);
  });

  it("accepts a bloom effect with all fields, and with none", () => {
    expect(
      postEffectConfigSchema.safeParse({ type: "bloom", threshold: 0.9, intensity: 1.2, radius: 0.5 }).success,
    ).toBe(true);
    expect(postEffectConfigSchema.safeParse({ type: "bloom" }).success).toBe(true);
  });

  it("accepts a depthOfField effect with all fields, and with none", () => {
    expect(
      postEffectConfigSchema.safeParse({
        type: "depthOfField",
        focusDistance: 12,
        aperture: 0.04,
        maxBlur: 2,
      }).success,
    ).toBe(true);
    expect(postEffectConfigSchema.safeParse({ type: "depthOfField" }).success).toBe(true);
  });

  it("accepts a chromaticAberration effect with and without intensity", () => {
    expect(postEffectConfigSchema.safeParse({ type: "chromaticAberration", intensity: 0.4 }).success).toBe(true);
    expect(postEffectConfigSchema.safeParse({ type: "chromaticAberration" }).success).toBe(true);
  });

  it("accepts a vignette effect with darkness and offset, and with neither", () => {
    expect(postEffectConfigSchema.safeParse({ type: "vignette", darkness: 0.6, offset: 1.2 }).success).toBe(
      true,
    );
    expect(postEffectConfigSchema.safeParse({ type: "vignette" }).success).toBe(true);
  });

  it("accepts a filmGrain effect with and without intensity", () => {
    expect(postEffectConfigSchema.safeParse({ type: "filmGrain", intensity: 0.3 }).success).toBe(true);
    expect(postEffectConfigSchema.safeParse({ type: "filmGrain" }).success).toBe(true);
  });

  it("accepts a lensDistortion effect with a positive (barrel) and negative (pincushion) amount", () => {
    expect(postEffectConfigSchema.safeParse({ type: "lensDistortion", amount: 0.1 }).success).toBe(true);
    expect(postEffectConfigSchema.safeParse({ type: "lensDistortion", amount: -0.1 }).success).toBe(true);
    expect(postEffectConfigSchema.safeParse({ type: "lensDistortion" }).success).toBe(true);
  });

  it("accepts a motionBlur effect with shutterAngle and samples, and with neither", () => {
    expect(postEffectConfigSchema.safeParse({ type: "motionBlur", shutterAngle: 270, samples: 24 }).success).toBe(
      true,
    );
    expect(postEffectConfigSchema.safeParse({ type: "motionBlur" }).success).toBe(true);
  });

  it("rejects each new effect type with an extra, unrecognized field", () => {
    expect(postEffectConfigSchema.safeParse({ type: "bloom", glow: true }).success).toBe(false);
    expect(postEffectConfigSchema.safeParse({ type: "depthOfField", blurriness: 1 }).success).toBe(false);
    expect(postEffectConfigSchema.safeParse({ type: "vignette", radius: 1 }).success).toBe(false);
    expect(postEffectConfigSchema.safeParse({ type: "motionBlur", exposure: 1 }).success).toBe(false);
  });
});

describe("clipSchema", () => {
  it("accepts a clip with startFrame 0", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 0,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative startFrame", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: -1,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer startFrame", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 1.5,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a durationInFrames of 0 (must be strictly positive)", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 0,
      durationInFrames: 0,
      node: sampleNode(),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a clip with no transitionIn (an implicit cut)", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 0,
      durationInFrames: 30,
      node: sampleNode(),
    });
    expect(result.success).toBe(true);
  });

  it("accepts a clip with a valid crossDissolve transitionIn", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 30,
      durationInFrames: 30,
      node: sampleNode(),
      transitionIn: { type: "crossDissolve", durationInFrames: 10 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a clip whose transitionIn is an invalid wipe missing direction", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 30,
      durationInFrames: 30,
      node: sampleNode(),
      transitionIn: { type: "wipe", durationInFrames: 10 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("transitionIn.direction"),
      );
      expect(issue).toBeDefined();
    }
  });

  it("rejects a clip whose transitionIn has a non-positive durationInFrames", () => {
    const result = clipSchema.safeParse({
      id: "clip-1",
      startFrame: 30,
      durationInFrames: 30,
      node: sampleNode(),
      transitionIn: { type: "fade", durationInFrames: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe("activeCameraEntrySchema", () => {
  it("accepts a valid entry", () => {
    const result = activeCameraEntrySchema.safeParse({
      startFrame: 0,
      durationInFrames: 60,
      cameraNodeId: "camera-1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative startFrame", () => {
    const result = activeCameraEntrySchema.safeParse({
      startFrame: -1,
      durationInFrames: 60,
      cameraNodeId: "camera-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive durationInFrames", () => {
    const result = activeCameraEntrySchema.safeParse({
      startFrame: 0,
      durationInFrames: 0,
      cameraNodeId: "camera-1",
    });
    expect(result.success).toBe(false);
  });
});

describe("trackSchema", () => {
  it("accepts a track with an empty clips array", () => {
    const result = trackSchema.safeParse({ id: "track-1", clips: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a track name as optional", () => {
    const result = trackSchema.safeParse({ id: "track-1", name: "Primary", clips: [] });
    expect(result.success).toBe(true);
  });
});

describe("audioFadeEnvelopeSchema", () => {
  it("accepts a valid envelope", () => {
    expect(audioFadeEnvelopeSchema.safeParse({ durationInFrames: 15 }).success).toBe(true);
  });

  it("accepts durationInFrames of 0", () => {
    expect(audioFadeEnvelopeSchema.safeParse({ durationInFrames: 0 }).success).toBe(true);
  });

  it("rejects a negative durationInFrames", () => {
    expect(audioFadeEnvelopeSchema.safeParse({ durationInFrames: -1 }).success).toBe(false);
  });

  it("rejects a non-integer durationInFrames", () => {
    expect(audioFadeEnvelopeSchema.safeParse({ durationInFrames: 1.5 }).success).toBe(false);
  });
});

describe("audioClipSchema", () => {
  function validAudioClip() {
    return {
      id: "audio-clip-1",
      startFrame: 0,
      durationInFrames: 30,
      assetRef: "music.mp3",
    };
  }

  it("accepts a minimal valid clip (only required fields)", () => {
    expect(audioClipSchema.safeParse(validAudioClip()).success).toBe(true);
  });

  it("accepts a clip with every optional field populated", () => {
    const result = audioClipSchema.safeParse({
      ...validAudioClip(),
      trimStartFrames: 10,
      gain: 0.8,
      fadeIn: { durationInFrames: 5 },
      fadeOut: { durationInFrames: 5 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative startFrame", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), startFrame: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer startFrame", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), startFrame: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a durationInFrames of 0 (must be strictly positive)", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), durationInFrames: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer durationInFrames", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), durationInFrames: 30.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative trimStartFrames", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), trimStartFrames: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer trimStartFrames", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), trimStartFrames: 2.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative gain, with a diagnostic naming the gain field", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), gain: -0.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) => candidate.path.join(".") === "gain");
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/non-negative/);
    }
  });

  it("accepts a gain of exactly 0 (silent, but not negative)", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), gain: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects a fadeIn longer than the clip's own durationInFrames, with a precise diagnostic", () => {
    const result = audioClipSchema.safeParse({
      ...validAudioClip(),
      durationInFrames: 10,
      fadeIn: { durationInFrames: 20 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("fadeIn"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/must not exceed this clip's own durationInFrames/);
    }
  });

  it("rejects a fadeOut longer than the clip's own durationInFrames, with a precise diagnostic", () => {
    const result = audioClipSchema.safeParse({
      ...validAudioClip(),
      durationInFrames: 10,
      fadeOut: { durationInFrames: 20 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("fadeOut"),
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toMatch(/must not exceed this clip's own durationInFrames/);
    }
  });

  it("accepts a fadeIn exactly equal to the clip's durationInFrames (the individual boundary)", () => {
    const result = audioClipSchema.safeParse({
      ...validAudioClip(),
      durationInFrames: 10,
      fadeIn: { durationInFrames: 10 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts fadeIn and fadeOut whose combined duration exceeds durationInFrames (only the individual bound is enforced)", () => {
    const result = audioClipSchema.safeParse({
      ...validAudioClip(),
      durationInFrames: 10,
      fadeIn: { durationInFrames: 8 },
      fadeOut: { durationInFrames: 8 },
    });
    expect(result.success).toBe(true);
  });

  it("reports both an over-long fadeIn and fadeOut as two separate issues", () => {
    const result = audioClipSchema.safeParse({
      ...validAudioClip(),
      durationInFrames: 5,
      fadeIn: { durationInFrames: 100 },
      fadeOut: { durationInFrames: 100 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const fadeInIssue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("fadeIn"),
      );
      const fadeOutIssue = result.error.issues.find((candidate) =>
        candidate.path.join(".").includes("fadeOut"),
      );
      expect(fadeInIssue).toBeDefined();
      expect(fadeOutIssue).toBeDefined();
    }
  });

  it("rejects an unknown extra field (strictObject)", () => {
    const result = audioClipSchema.safeParse({ ...validAudioClip(), unexpectedField: true });
    expect(result.success).toBe(false);
  });
});

describe("audioTrackSchema", () => {
  it("accepts a track with an empty clips array", () => {
    const result = audioTrackSchema.safeParse({ id: "audio-track-1", clips: [] });
    expect(result.success).toBe(true);
  });

  it("accepts a track name as optional", () => {
    const result = audioTrackSchema.safeParse({
      id: "audio-track-1",
      name: "Music",
      clips: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a track whose clips array contains an invalid clip", () => {
    const result = audioTrackSchema.safeParse({
      id: "audio-track-1",
      clips: [{ id: "clip-1", startFrame: -1, durationInFrames: 30, assetRef: "a.mp3" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("compositionSchema", () => {
  function validComposition() {
    return {
      id: "comp-1",
      name: "Main",
      fps: 30,
      durationInFrames: 300,
      width: 1920,
      height: 1080,
      tracks: [],
    };
  }

  it("accepts a fully valid composition", () => {
    expect(compositionSchema.safeParse(validComposition()).success).toBe(true);
  });

  it("rejects a non-integer fps", () => {
    const result = compositionSchema.safeParse({ ...validComposition(), fps: 29.97 });
    expect(result.success).toBe(false);
  });

  it("rejects a zero or negative fps", () => {
    expect(compositionSchema.safeParse({ ...validComposition(), fps: 0 }).success).toBe(false);
    expect(compositionSchema.safeParse({ ...validComposition(), fps: -30 }).success).toBe(false);
  });

  it("rejects a non-integer durationInFrames", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      durationInFrames: 100.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer width or height", () => {
    expect(compositionSchema.safeParse({ ...validComposition(), width: 1920.5 }).success).toBe(
      false,
    );
    expect(compositionSchema.safeParse({ ...validComposition(), height: 1080.5 }).success).toBe(
      false,
    );
  });

  it("rejects a zero width or height", () => {
    expect(compositionSchema.safeParse({ ...validComposition(), width: 0 }).success).toBe(false);
    expect(compositionSchema.safeParse({ ...validComposition(), height: 0 }).success).toBe(false);
  });

  it("accepts a composition with an activeCameraTrack", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      activeCameraTrack: [
        { startFrame: 0, durationInFrames: 60, cameraNodeId: "camera-a" },
        { startFrame: 60, durationInFrames: 60, cameraNodeId: "camera-b" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a composition whose activeCameraTrack has an invalid entry", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      activeCameraTrack: [{ startFrame: 0, durationInFrames: -1, cameraNodeId: "camera-a" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a composition with no audioTracks at all (every composition authored before Phase 16)", () => {
    expect(compositionSchema.safeParse(validComposition()).success).toBe(true);
  });

  it("accepts a composition with audioTracks", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      audioTracks: [
        {
          id: "audio-track-1",
          clips: [
            { id: "clip-1", startFrame: 0, durationInFrames: 90, assetRef: "music.mp3", gain: 0.8 },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a composition whose audioTracks contains an invalid clip", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      audioTracks: [
        {
          id: "audio-track-1",
          clips: [{ id: "clip-1", startFrame: 0, durationInFrames: 90, assetRef: "m.mp3", gain: -1 }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a composition with a postProcessing effect stack", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      postProcessing: { tier: "preview", effects: [{ type: "sharpen", amount: 0.6 }] },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a composition with an empty postProcessing.effects array (a no-op)", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      postProcessing: { effects: [] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a composition whose postProcessing.effects contains an invalid entry", () => {
    const result = compositionSchema.safeParse({
      ...validComposition(),
      postProcessing: { effects: [{ type: "sparkle" }] },
    });
    expect(result.success).toBe(false);
  });
});

describe("projectSchema", () => {
  it("accepts a project with an empty compositions array", () => {
    const result = projectSchema.safeParse({ id: "p1", name: "My Project", compositions: [] });
    expect(result.success).toBe(true);
  });

  it("rejects a project missing an id", () => {
    const result = projectSchema.safeParse({ name: "My Project", compositions: [] });
    expect(result.success).toBe(false);
  });
});
