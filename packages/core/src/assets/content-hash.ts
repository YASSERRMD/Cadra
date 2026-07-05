/**
 * Deterministic content hashing for asset bytes.
 *
 * Mirrors `scene-graph/id-generator.ts`'s `hashStringSeed`: the same djb2
 * accumulation, run here over byte content instead of a seed string. Two
 * independent djb2 passes (different starting constants) are combined into
 * one wider hex string so content-addressed asset dedup has a large enough
 * hash space to make accidental collisions between unrelated assets
 * negligible in practice, while staying dependency-free and just as simple
 * as the single-pass version id-generator.ts uses for its narrower purpose.
 */

/** A hex-encoded content hash, used to content-address loaded asset bytes. */
export type ContentHash = string;

/**
 * Runs one djb2 accumulation over `bytes`, seeded from `initial` instead of
 * the conventional 5381 constant, so two passes with different seeds walk
 * the same bytes into two different 32-bit states.
 */
function djb2OverBytes(bytes: Uint8Array, initial: number): number {
  let hash = initial;
  for (let i = 0; i < bytes.length; i += 1) {
    // hash * 33 ^ byte, kept within 32-bit unsigned range, same recurrence
    // as id-generator.ts's hashStringSeed.
    hash = (hash * 33 + (bytes[i] as number)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Hashes asset bytes down to a deterministic hex content hash.
 *
 * The same bytes always produce the same hash, regardless of how many times
 * this is called or in what process; different bytes are overwhelmingly
 * likely to produce different hashes. This is the sole content-addressing
 * primitive asset dedup is built on: do not reimplement hashing elsewhere,
 * reuse this.
 */
export function hashAssetBytes(bytes: Uint8Array): ContentHash {
  const low = djb2OverBytes(bytes, 5381);
  const high = djb2OverBytes(bytes, 52711);
  return `${low.toString(16).padStart(8, "0")}${high.toString(16).padStart(8, "0")}`;
}
