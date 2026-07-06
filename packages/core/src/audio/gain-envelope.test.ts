import { describe, expect, it } from "vitest";

import type { AudioClip } from "../scene-graph/timeline.js";
import { computeGainAtLocalFrame } from "./gain-envelope.js";

function makeClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    id: "clip-1",
    startFrame: 0,
    durationInFrames: 30,
    assetRef: "audio-1",
    ...overrides,
  };
}

describe("computeGainAtLocalFrame: no fades", () => {
  it("returns the constant gain everywhere in the clip's window when neither fade is set", () => {
    const clip = makeClip({ gain: 0.75 });
    expect(computeGainAtLocalFrame(clip, 0)).toBe(0.75);
    expect(computeGainAtLocalFrame(clip, 15)).toBe(0.75);
    expect(computeGainAtLocalFrame(clip, 29)).toBe(0.75);
  });

  it("defaults gain to 1 when omitted", () => {
    const clip = makeClip();
    expect(computeGainAtLocalFrame(clip, 10)).toBe(1);
  });

  it("clamps to the boundary gain outside the clip's own window", () => {
    const clip = makeClip({ gain: 0.5 });
    expect(computeGainAtLocalFrame(clip, -5)).toBe(0.5);
    expect(computeGainAtLocalFrame(clip, 100)).toBe(0.5);
  });
});

describe("computeGainAtLocalFrame: fadeIn only", () => {
  it("starts at 0 on the clip's first frame", () => {
    const clip = makeClip({ gain: 1, fadeIn: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 0)).toBe(0);
  });

  it("reaches full gain exactly at the fade's end boundary", () => {
    const clip = makeClip({ gain: 1, fadeIn: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 10)).toBe(1);
  });

  it("is at half gain at the fade's midpoint", () => {
    const clip = makeClip({ gain: 1, fadeIn: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 5)).toBeCloseTo(0.5);
  });

  it("holds at full gain for the remainder of the clip after the fade completes", () => {
    const clip = makeClip({ gain: 1, fadeIn: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 20)).toBe(1);
    expect(computeGainAtLocalFrame(clip, 29)).toBe(1);
  });

  it("ramps up to clip.gain (not always 1) when gain is not the default", () => {
    const clip = makeClip({ gain: 0.4, fadeIn: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 0)).toBe(0);
    expect(computeGainAtLocalFrame(clip, 10)).toBeCloseTo(0.4);
    expect(computeGainAtLocalFrame(clip, 5)).toBeCloseTo(0.2);
  });
});

describe("computeGainAtLocalFrame: fadeOut only", () => {
  it("is at full gain up until the fade's start boundary", () => {
    const clip = makeClip({ gain: 1, durationInFrames: 30, fadeOut: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 0)).toBe(1);
    expect(computeGainAtLocalFrame(clip, 20)).toBe(1);
  });

  it("is at half gain at the fade's midpoint", () => {
    const clip = makeClip({ gain: 1, durationInFrames: 30, fadeOut: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 25)).toBeCloseTo(0.5);
  });

  it("reaches 0 exactly on the clip's last frame (durationInFrames)", () => {
    const clip = makeClip({ gain: 1, durationInFrames: 30, fadeOut: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 30)).toBe(0);
  });

  it("is nearly silent on the last actually-visible frame just before the end", () => {
    const clip = makeClip({ gain: 1, durationInFrames: 30, fadeOut: { durationInFrames: 10 } });
    expect(computeGainAtLocalFrame(clip, 29)).toBeCloseTo(0.1);
  });
});

describe("computeGainAtLocalFrame: fadeIn and fadeOut together", () => {
  const clip = makeClip({
    gain: 1,
    durationInFrames: 30,
    fadeIn: { durationInFrames: 10 },
    fadeOut: { durationInFrames: 10 },
  });

  it("starts at 0", () => {
    expect(computeGainAtLocalFrame(clip, 0)).toBe(0);
  });

  it("reaches full gain at the end of fadeIn", () => {
    expect(computeGainAtLocalFrame(clip, 10)).toBe(1);
  });

  it("holds at full gain on the flat middle section", () => {
    expect(computeGainAtLocalFrame(clip, 15)).toBe(1);
    expect(computeGainAtLocalFrame(clip, 19)).toBe(1);
  });

  it("is still at full gain exactly at the start of fadeOut", () => {
    expect(computeGainAtLocalFrame(clip, 20)).toBe(1);
  });

  it("ends at 0 on the clip's last frame", () => {
    expect(computeGainAtLocalFrame(clip, 30)).toBe(0);
  });

  it("ramps down symmetrically during fadeOut", () => {
    expect(computeGainAtLocalFrame(clip, 25)).toBeCloseTo(0.5);
  });
});

describe("computeGainAtLocalFrame: clip too short for its authored fade durations", () => {
  it("clamps each fade to at most half the clip's duration so the ramps meet, not cross, at the midpoint", () => {
    // durationInFrames 10, fadeIn/fadeOut both authored at 8 (16 total,
    // exceeding the clip's own duration): each effectively clamps to half
    // (5 for fadeIn via floor(10/2), 5 for fadeOut via ceil(10/2)).
    const clip = makeClip({
      gain: 1,
      durationInFrames: 10,
      fadeIn: { durationInFrames: 8 },
      fadeOut: { durationInFrames: 8 },
    });

    expect(computeGainAtLocalFrame(clip, 0)).toBe(0);
    // Peak at the midpoint, where the clamped fadeIn ends and fadeOut begins.
    expect(computeGainAtLocalFrame(clip, 5)).toBe(1);
    expect(computeGainAtLocalFrame(clip, 10)).toBe(0);
  });

  it("is monotonically increasing then decreasing, never dipping and rising again", () => {
    const clip = makeClip({
      gain: 1,
      durationInFrames: 11,
      fadeIn: { durationInFrames: 100 },
      fadeOut: { durationInFrames: 100 },
    });

    const gains = Array.from({ length: 12 }, (_, frame) => computeGainAtLocalFrame(clip, frame));
    let peakIndex = 0;
    for (let i = 1; i < gains.length; i += 1) {
      const previous = gains[i - 1] as number;
      const current = gains[i] as number;
      if (current > previous) {
        peakIndex = i;
      } else if (current < previous) {
        // Once we start decreasing, every subsequent step must not increase.
        expect(current).toBeLessThanOrEqual(previous);
      }
    }
    expect(peakIndex).toBeGreaterThan(0);
  });

  it("still respects an odd clip duration by splitting floor/ceil across the two fades", () => {
    // durationInFrames 9: half is 4.5, so fadeIn clamps to floor(4.5) = 4 and
    // fadeOut clamps to ceil(4.5) = 5, summing back to exactly 9.
    const clip = makeClip({
      gain: 1,
      durationInFrames: 9,
      fadeIn: { durationInFrames: 8 },
      fadeOut: { durationInFrames: 8 },
    });

    expect(computeGainAtLocalFrame(clip, 0)).toBe(0);
    expect(computeGainAtLocalFrame(clip, 4)).toBe(1);
    expect(computeGainAtLocalFrame(clip, 9)).toBe(0);
  });
});
