// src/quota.ts
import type { Env } from "./auth";

export const DEFAULT_BUDGET_TOKENS = 4_000_000;

export interface QuotaStatus {
  allowed: boolean;
  tokensUsed: number;
  tokenBudget: number;
  resetAt: string;
  error: "ok" | "exceeded" | "unavailable";
}

/**
 * Calculates the start of the current month and start of next month in UTC.
 */
export function getMonthWindowUTC(now: Date = new Date()): {
  startOfMonthISO: string;
  resetAtISO: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const startOfNextMonth = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));

  return {
    startOfMonthISO: startOfMonth.toISOString(),
    resetAtISO: startOfNextMonth.toISOString(),
  };
}

/**
 * Checks a user's monthly token quota in D1 before making an upstream request.
 *
 * Fail-CLOSED: If either D1 query fails, access is denied with error "unavailable"
 * to prevent unlimited free usage against provider keys during an outage.
 *
 * NOTE (Accepted v1 limitation): Check-then-act without pre-reservation.
 * Two concurrent requests arriving at the same millisecond can both pass quota
 * checks before either completes. v2 will reserve an estimated token count
 * prior to dispatching upstream.
 */
export async function checkQuota(
  db: D1Database,
  userId: string,
  env: Env,
  now: Date = new Date(),
): Promise<QuotaStatus> {
  const { startOfMonthISO, resetAtISO } = getMonthWindowUTC(now);

  // Explicit entitlement is required; absence never grants provider access.
  try {
    const entitlement = await db
      .prepare("SELECT status, expires_at FROM entitlements WHERE user_id = ?")
      .bind(userId)
      .first<{ status: string; expires_at: string }>();
    if (
      !entitlement ||
      entitlement.status !== "active" ||
      !Number.isFinite(Date.parse(entitlement.expires_at)) ||
      Date.parse(entitlement.expires_at) <= now.getTime()
    ) {
      return {
        allowed: false,
        tokensUsed: 0,
        tokenBudget: 0,
        resetAt: resetAtISO,
        error: "exceeded",
      };
    }
  } catch {
    return {
      allowed: false,
      tokensUsed: 0,
      tokenBudget: 0,
      resetAt: resetAtISO,
      error: "unavailable",
    };
  }

  // Determine user's monthly token budget fallback
  let budget = DEFAULT_BUDGET_TOKENS;
  if (env.DEFAULT_MONTHLY_TOKENS) {
    const parsed = parseInt(env.DEFAULT_MONTHLY_TOKENS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      budget = parsed;
    }
  }

  // 1. Query custom quota from D1 (fail-closed if D1 throws)
  try {
    const quotaRow = await db
      .prepare("SELECT monthly_tokens FROM quotas WHERE user_id = ?")
      .bind(userId)
      .first<{ monthly_tokens: number }>();

    if (quotaRow && typeof quotaRow.monthly_tokens === "number") {
      budget = quotaRow.monthly_tokens;
    }
  } catch (err) {
    console.error("[quota] CRITICAL: D1 query for quotas failed loudly:", err);
    return {
      allowed: false,
      tokensUsed: 0,
      tokenBudget: budget,
      resetAt: resetAtISO,
      error: "unavailable",
    };
  }

  // 2. Query tokens consumed since the 1st of the current month UTC (fail-closed if D1 throws)
  let tokensUsed = 0;
  try {
    const usageRow = await db
      .prepare("SELECT tokens AS total FROM budget_totals WHERE user_id=? AND month=?")
      .bind(userId, startOfMonthISO)
      .first<{ total: number }>();

    if (usageRow && typeof usageRow.total === "number") {
      tokensUsed = usageRow.total;
    }
  } catch (err) {
    console.error("[quota] CRITICAL: D1 query for usage sum failed loudly:", err);
    return {
      allowed: false,
      tokensUsed: 0,
      tokenBudget: budget,
      resetAt: resetAtISO,
      error: "unavailable",
    };
  }

  const allowed = tokensUsed < budget;

  return {
    allowed,
    tokensUsed,
    tokenBudget: budget,
    resetAt: resetAtISO,
    error: allowed ? "ok" : "exceeded",
  };
}
