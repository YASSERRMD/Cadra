import { describe, expect, it } from "vitest";

import { hashAssetBytes } from "./content-hash.js";

function bytesFrom(values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe("hashAssetBytes", () => {
  it("produces the same hash for the same bytes, called repeatedly", () => {
    const bytes = bytesFrom([1, 2, 3, 4, 5, 250, 0, 128]);

    const first = hashAssetBytes(bytes);
    const second = hashAssetBytes(bytes);
    const third = hashAssetBytes(bytes);

    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("produces the same hash for two separately-constructed but byte-identical arrays", () => {
    const a = bytesFrom([10, 20, 30, 40]);
    const b = bytesFrom([10, 20, 30, 40]);

    expect(hashAssetBytes(a)).toBe(hashAssetBytes(b));
  });

  it("produces different hashes for different bytes, in practice", () => {
    const a = bytesFrom([1, 2, 3, 4]);
    const b = bytesFrom([1, 2, 3, 5]);

    expect(hashAssetBytes(a)).not.toBe(hashAssetBytes(b));
  });

  it("produces different hashes for different-length byte content, in practice", () => {
    const short = bytesFrom([7, 7, 7]);
    const long = bytesFrom([7, 7, 7, 7, 7, 7, 7, 7]);

    expect(hashAssetBytes(short)).not.toBe(hashAssetBytes(long));
  });

  it("produces different hashes across a batch of distinct byte contents, in practice", () => {
    const samples = Array.from({ length: 50 }, (_, i) =>
      bytesFrom(Array.from({ length: 16 }, (_, j) => (i * 31 + j * 7) % 256)),
    );

    const hashes = samples.map(hashAssetBytes);

    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("hashes an empty byte array without throwing, deterministically", () => {
    const empty = bytesFrom([]);

    const first = hashAssetBytes(empty);
    const second = hashAssetBytes(empty);

    expect(first).toBe(second);
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
  });

  it("returns a hex-encoded string", () => {
    const hash = hashAssetBytes(bytesFrom([1, 2, 3]));

    expect(hash).toMatch(/^[0-9a-f]+$/);
  });
});
