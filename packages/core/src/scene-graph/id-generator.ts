/**
 * Deterministic, seedable id generation.
 *
 * Agent-generated scene graphs need reproducible ids: the same authoring
 * session, replayed with the same seed, must produce byte-identical output
 * so results can be diffed and cached. This is a small, self-contained
 * utility scoped to Phase 2; it does not depend on the deterministic clock
 * or PRNG a later phase adds for scene-content randomness (those seed a
 * per-frame render RNG, this seeds id strings at construction time).
 */

/** Number of base36 characters produced per generated id. */
const ID_LENGTH = 12;

/**
 * Hashes a string seed down to a 32-bit unsigned integer using the classic
 * djb2 algorithm. Used only to turn an arbitrary string seed into a numeric
 * seed for the PRNG below; not intended as a general-purpose hash.
 */
function hashStringSeed(seed: string): number {
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    // hash * 33 ^ charCode, kept within 32-bit unsigned range.
    hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Creates a mulberry32 PRNG step function from a 32-bit integer seed.
 * Mulberry32 is a small, fast, well-distributed generator that is fully
 * deterministic: the same seed always produces the same output sequence.
 * Returns a function that yields the next float in [0, 1) on each call and
 * advances internal state as a side effect local to the closure.
 */
function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates an id generator function seeded deterministically from `seed`.
 *
 * Two generators created with the same seed produce the exact same sequence
 * of ids when called the same number of times, in order. Different seeds are
 * overwhelmingly likely to produce different sequences.
 *
 * @param seed - A string or number used to derive the initial PRNG state.
 * @returns A zero-argument function that returns the next id string each
 *   time it is called.
 */
export function createIdGenerator(seed: string | number): () => string {
  const numericSeed = typeof seed === "string" ? hashStringSeed(seed) : seed >>> 0;
  const next = createMulberry32(numericSeed);

  return function generateId(): string {
    let id = "";
    while (id.length < ID_LENGTH) {
      // Each draw yields a float in [0, 1); base36 of a large integer slice
      // of it gives a few unpredictable-looking alphanumeric characters.
      const chunk = Math.floor(next() * 36 ** 6)
        .toString(36)
        .padStart(6, "0");
      id += chunk;
    }
    return id.slice(0, ID_LENGTH);
  };
}
