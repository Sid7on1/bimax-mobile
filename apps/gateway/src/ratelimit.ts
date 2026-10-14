// src/ratelimit.ts
import type { Env } from "./auth";

export const DEFAULT_RATE_LIMIT_PER_MIN = 30;

export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

/**
 * Returns UTC timestamp formatted as YYYYMMDDHHMM for minute-bucket grouping.
 */
export function getMinuteBucketUTC(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const h = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}${m}${d}${h}${min}`;
}

/**
 * Checks and increments the per-minute rate limit counter in KV.
 * Key: rl:<keyHash>:<YYYYMMDDHHMM>
 * Limit: RATE_LIMIT_PER_MIN (default 30)
 * Expiration: 90s
 *
 * NOTE (Fail-OPEN design choice for v1):
 * If KV read or write operations throw, we log loudly with console.error but
 * allow the request through. For v1 rate limiting, service availability is
 * prioritized over strict abuse prevention during intermittent KV degradations.
 */
export async function checkRateLimit(
  keyHash: string,
  env: Env,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  let limit = DEFAULT_RATE_LIMIT_PER_MIN;
  if (env.RATE_LIMIT_PER_MIN) {
    const parsed = parseInt(env.RATE_LIMIT_PER_MIN, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = parsed;
    }
  }

  const bucket = getMinuteBucketUTC(now);
  const kvKey = `rl:${keyHash}:${bucket}`;

  let currentCount = 0;
  try {
    const rawVal = await env.GATEWAY_RATELIMIT.get(kvKey);
    if (rawVal) {
      currentCount = parseInt(rawVal, 10) || 0;
    }
  } catch (err) {
    console.error("[ratelimit] CRITICAL: KV read failed loudly; failing open:", err);
  }

  if (currentCount >= limit) {
    return {
      allowed: false,
      retryAfter: 60,
    };
  }

  // Increment counter with 90s TTL
  try {
    await env.GATEWAY_RATELIMIT.put(kvKey, String(currentCount + 1), {
      expirationTtl: 90,
    });
  } catch (err) {
    console.error("[ratelimit] CRITICAL: KV write failed loudly; failing open:", err);
  }

  return { allowed: true };
}
