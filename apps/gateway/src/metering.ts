// src/metering.ts

export interface UsageRecord {
  userId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  usageMissing?: boolean;
  createdAt?: string;
}

/**
 * Writes a completed request's token usage to D1.
 * Fail-safe: D1 write errors are caught and logged so that metering issues
 * never fail the client response.
 */
export async function recordUsage(
  db: D1Database,
  record: UsageRecord,
): Promise<void> {
  const createdAt = record.createdAt || new Date().toISOString();
  const usageMissingFlag = record.usageMissing ? 1 : 0;

  if (record.usageMissing) {
    console.warn(
      `[metering] Warning: Missing usage object from provider for user ${record.userId}, model ${record.model}. Recording zeros.`,
    );
  }

  try {
    await db
      .prepare(
        "INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, created_at, usage_missing) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        record.userId,
        record.model,
        record.promptTokens,
        record.completionTokens,
        createdAt,
        usageMissingFlag,
      )
      .run();
  } catch (err) {
    console.error("[metering] Failed to record usage to D1:", err);
  }
}
