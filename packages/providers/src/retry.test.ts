import { describe, expect, it, vi } from "vitest";

import { fetchWithRetry } from "./retry.js";

/** Builds a bare-bones JSON `Response` with the given status, mirroring how a fixture-backed adapter test constructs a fake vendor response. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchWithRetry", () => {
  it("returns the first response immediately on a 2xx success, with no retry and no sleep", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    const sleepFn = vi.fn(async () => undefined);

    const response = await fetchWithRetry("https://example.test/x", undefined, { fetchFn, sleepFn });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("returns immediately on a non-retryable 4xx response (e.g. 400), with no retry", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: "bad request" }));
    const sleepFn = vi.fn(async () => undefined);

    const response = await fetchWithRetry("https://example.test/x", undefined, { fetchFn, sleepFn });

    expect(response.status).toBe(400);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("retries a 429 rate-limit response and succeeds once the vendor recovers", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return jsonResponse(429, { error: "rate limited" });
      }
      return jsonResponse(200, { ok: true });
    });
    const sleepFn = vi.fn(async () => undefined);

    const response = await fetchWithRetry("https://example.test/x", undefined, {
      fetchFn,
      sleepFn,
      maxAttempts: 5,
    });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx server error using exponential backoff delays", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(503, { error: "server error" }));
    const sleepFn = vi.fn(async () => undefined);

    const response = await fetchWithRetry("https://example.test/x", undefined, {
      fetchFn,
      sleepFn,
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
    });

    // Exhausts all 3 attempts (every one returns 503) and returns the last
    // attempt's response rather than throwing, since a persistent 5xx is
    // still a well-formed HTTP response for the caller's own status-code
    // handling to interpret.
    expect(response.status).toBe(503);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenNthCalledWith(1, 100);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 200);
  });

  it("caps the backoff delay at maxDelayMs regardless of how many doublings would otherwise apply", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: "server error" }));
    const sleepFn = vi.fn(async () => undefined);

    await fetchWithRetry("https://example.test/x", undefined, {
      fetchFn,
      sleepFn,
      maxAttempts: 4,
      baseDelayMs: 1000,
      maxDelayMs: 1500,
    });

    // 1000 -> 2000 (capped to 1500) -> 4000 (capped to 1500).
    expect(sleepFn).toHaveBeenNthCalledWith(1, 1000);
    expect(sleepFn).toHaveBeenNthCalledWith(2, 1500);
    expect(sleepFn).toHaveBeenNthCalledWith(3, 1500);
  });

  it("retries a rejected fetchFn call (network-level failure) and succeeds once it recovers", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        throw new Error("ECONNRESET");
      }
      return jsonResponse(200, { ok: true });
    });
    const sleepFn = vi.fn(async () => undefined);

    const response = await fetchWithRetry("https://example.test/x", undefined, { fetchFn, sleepFn });

    expect(response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last network-level error once every attempt is exhausted", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const sleepFn = vi.fn(async () => undefined);

    await expect(
      fetchWithRetry("https://example.test/x", undefined, { fetchFn, sleepFn, maxAttempts: 2 }),
    ).rejects.toThrow("ECONNRESET");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("makes exactly one attempt and never sleeps when maxAttempts is 1", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: "server error" }));
    const sleepFn = vi.fn(async () => undefined);

    const response = await fetchWithRetry("https://example.test/x", undefined, {
      fetchFn,
      sleepFn,
      maxAttempts: 1,
    });

    expect(response.status).toBe(500);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("throws a RangeError for a maxAttempts less than 1", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, {}));

    await expect(
      fetchWithRetry("https://example.test/x", undefined, { fetchFn, maxAttempts: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("passes input and init through to fetchFn unchanged", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { ok: true }));
    const init: RequestInit = { method: "POST", body: JSON.stringify({ a: 1 }) };

    await fetchWithRetry("https://example.test/submit", init, { fetchFn });

    expect(fetchFn).toHaveBeenCalledWith("https://example.test/submit", init);
  });
});
