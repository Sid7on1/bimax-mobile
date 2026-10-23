import type { Env } from "./auth";
export const DEFAULT_RATE_LIMIT_PER_MIN = 30;
export interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
  unavailable?: boolean;
}
export function getMinuteBucketUTC(now = new Date()): string {
  return now.toISOString().slice(0, 16).replace(/[-T:]/g, "");
}
/** Atomic D1 write, keyed to user identity rather than a rotating JWT. */
export async function checkRateLimit(
  userId: string,
  env: Env,
  now = new Date(),
): Promise<RateLimitResult> {
  const configured = Number(env.RATE_LIMIT_PER_MIN ?? DEFAULT_RATE_LIMIT_PER_MIN);
  const limit =
    Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_RATE_LIMIT_PER_MIN;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits(user_id,bucket,count) VALUES (?,?,1)
      ON CONFLICT(user_id,bucket) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`,
    )
      .bind(userId, getMinuteBucketUTC(now), limit)
      .first<{ count: number }>();
    return { allowed: !!row, retryAfter: row ? undefined : 60 };
  } catch {
    return { allowed: false, retryAfter: 60, unavailable: true };
  }
}
