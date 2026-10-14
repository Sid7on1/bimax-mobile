// test/ratelimit.test.ts
import { describe, it, expect } from "vitest";
import { checkRateLimit, getMinuteBucketUTC } from "../src/ratelimit";
import { createTestEnv } from "./mocks";

describe("ratelimit module", () => {
  it("allows requests up to the limit and blocks the next request with 429", async () => {
    const { env } = createTestEnv({ RATE_LIMIT_PER_MIN: "5" });
    const now = new Date("2026-10-14T12:00:00Z");
    const keyHash = "hash-user-1";

    for (let i = 0; i < 5; i++) {
      const res = await checkRateLimit(keyHash, env, now);
      expect(res.allowed).toBe(true);
    }

    // 6th request must be blocked
    const blockedRes = await checkRateLimit(keyHash, env, now);
    expect(blockedRes.allowed).toBe(false);
    expect(blockedRes.retryAfter).toBe(60);
  });

  it("resets rate limit counter when minute window rolls over", async () => {
    const { env } = createTestEnv({ RATE_LIMIT_PER_MIN: "2" });
    const minute1 = new Date("2026-10-14T12:00:00Z");
    const minute2 = new Date("2026-10-14T12:01:00Z");
    const keyHash = "hash-user-2";

    expect((await checkRateLimit(keyHash, env, minute1)).allowed).toBe(true);
    expect((await checkRateLimit(keyHash, env, minute1)).allowed).toBe(true);
    expect((await checkRateLimit(keyHash, env, minute1)).allowed).toBe(false);

    // New minute window must allow requests again
    const resMinute2 = await checkRateLimit(keyHash, env, minute2);
    expect(resMinute2.allowed).toBe(true);
  });

  it("isolates rate limits per key hash", async () => {
    const { env } = createTestEnv({ RATE_LIMIT_PER_MIN: "1" });
    const now = new Date("2026-10-14T12:00:00Z");

    const keyA = "hash-key-a";
    const keyB = "hash-key-b";

    expect((await checkRateLimit(keyA, env, now)).allowed).toBe(true);
    expect((await checkRateLimit(keyA, env, now)).allowed).toBe(false);

    // keyB is unaffected by keyA's rate limit
    expect((await checkRateLimit(keyB, env, now)).allowed).toBe(true);
  });
});
