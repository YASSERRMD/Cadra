import { frameToTime } from "../frame/frame-time.js";

/**
 * Computes the exact timestamp (in seconds) a video asset must be sampled at
 * to depict a given composition frame, at a given frame rate.
 *
 * This is `frameToTime` under a name specific to the video-sampling call
 * site: video seeking must be driven by this deterministic frame/fps math,
 * never by a video element's own real-time playback position, so headless
 * renders never race against decode timing. Deliberately not reimplemented:
 * `frameToTime(frame, fps)` already computes exactly this.
 */
export function videoSampleTimestamp(frame: number, fps: number): number {
  return frameToTime(frame, fps);
}
