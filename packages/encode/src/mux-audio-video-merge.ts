import type { EncodedAudioChunkResult } from "./encode-audio.js";
import type { EncodedChunkResult } from "./encode-frames.js";

/**
 * One item as `mergeVideoAndAudioChunks` yields it: a discriminated union
 * tagging which of the two source streams (`encodeFrames`'s video chunks,
 * `encodeAudio`'s audio chunks) a given result came from, so a muxing feed
 * loop can route each one to `addVideoChunkRaw`/`addAudioChunkRaw`
 * correctly with a single `switch`/`if` on `kind`.
 */
export type MergedChunkResult =
  | { kind: "video"; result: EncodedChunkResult }
  | { kind: "audio"; result: EncodedAudioChunkResult };

/**
 * Merges `videoChunks` and `audioChunks` into one stream, yielding whichever
 * of the two next becomes available first, so both encoders can make
 * progress concurrently and neither stream is fully buffered in memory
 * before the other is even started.
 *
 * This is not a timestamp-based interleave (it does not attempt to yield
 * chunks in presentation-time order across the two streams): both
 * mp4-muxer's and webm-muxer's `addVideoChunkRaw`/`addAudioChunkRaw` accept
 * chunks for either track in any call order (each track's own samples only
 * need to be in order relative to themselves, which both `encodeFrames` and
 * `encodeAudio` already guarantee on their own), so a muxing feed loop
 * consuming this merge has no ordering requirement to satisfy beyond "video
 * chunks arrive in video order, audio chunks arrive in audio order" (each
 * individually true simply because this function never reorders within a
 * single source). Racing the two sources this way (rather than draining one
 * source to completion before starting the other) is what actually lets
 * both encoders pipeline concurrently.
 *
 * Once one source is exhausted, this function continues draining the
 * other alone until it, too, is exhausted, then finishes.
 */
export async function* mergeVideoAndAudioChunks(
  videoChunks: AsyncGenerator<EncodedChunkResult>,
  audioChunks: AsyncGenerator<EncodedAudioChunkResult>,
): AsyncGenerator<MergedChunkResult, void, void> {
  type PendingSlot =
    | { kind: "video"; promise: Promise<IteratorResult<EncodedChunkResult>> }
    | { kind: "audio"; promise: Promise<IteratorResult<EncodedAudioChunkResult>> };

  let videoDone = false;
  let audioDone = false;
  let pendingVideo: PendingSlot | undefined;
  let pendingAudio: PendingSlot | undefined;

  try {
    while (!videoDone || !audioDone) {
      if (!videoDone && pendingVideo === undefined) {
        pendingVideo = { kind: "video", promise: videoChunks.next() };
      }
      if (!audioDone && pendingAudio === undefined) {
        pendingAudio = { kind: "audio", promise: audioChunks.next() };
      }

      const racers: Array<Promise<{ kind: "video" | "audio" }>> = [];
      if (pendingVideo !== undefined) {
        racers.push(
          pendingVideo.promise.then((iterResult) => ({ kind: "video" as const, iterResult })),
        );
      }
      if (pendingAudio !== undefined) {
        racers.push(
          pendingAudio.promise.then((iterResult) => ({ kind: "audio" as const, iterResult })),
        );
      }

      // Cast is required: TypeScript cannot infer the discriminated shape
      // Promise.race's winner carries (kind plus that kind's own
      // iterResult) from this array's own declared element type
      // (Promise<{ kind: "video" | "audio" }>, deliberately narrow so the
      // array above type-checks with two structurally different Promise
      // element types); the runtime object always does carry both fields
      // together, since each racer's .then callback constructs them as one
      // literal.
      const winner = (await Promise.race(racers)) as
        | { kind: "video"; iterResult: IteratorResult<EncodedChunkResult> }
        | { kind: "audio"; iterResult: IteratorResult<EncodedAudioChunkResult> };

      if (winner.kind === "video") {
        pendingVideo = undefined;
        if (winner.iterResult.done === true) {
          videoDone = true;
        } else {
          yield { kind: "video", result: winner.iterResult.value };
        }
      } else {
        pendingAudio = undefined;
        if (winner.iterResult.done === true) {
          audioDone = true;
        } else {
          yield { kind: "audio", result: winner.iterResult.value };
        }
      }
    }
  } finally {
    // Early termination (the consumer breaks its `for await` loop): return()
    // on whichever source generator has not yet reported done, mirroring
    // encodeFrames'/captureFrames' own finally-based disposal so an
    // in-flight source render/encode is never left dangling.
    if (!videoDone) {
      await videoChunks.return(undefined);
    }
    if (!audioDone) {
      await audioChunks.return(undefined);
    }
  }
}
