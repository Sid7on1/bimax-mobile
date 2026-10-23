export interface VerifiedUsage {
  requestId: string;
  providerRequestId: string;
  promptTokens: number;
  completionTokens: number;
  operator: string;
  reason: string;
  evidenceSha256: string;
}

/** Used only by a trusted operator after matching provider billing evidence to this request. */
export function reconciliationStatement(record: VerifiedUsage) {
  for (const field of ["requestId", "providerRequestId", "operator", "reason"] as const) {
    if (typeof record[field] !== "string" || !record[field].trim() || record[field].length > 1024)
      throw new Error(`Invalid ${field}`);
  }
  if (!/^[a-f0-9]{64}$/.test(record.evidenceSha256)) throw new Error("Invalid evidence hash");
  if (![record.promptTokens, record.completionTokens].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("Invalid verified usage");
  // SQLite's integers are wider than JS's. Bound multiplication before it enters SQL.
  // Price validation below also protects imported/corrupt reservations.
  return {
    sql: `INSERT INTO billing_reconciliations(
      request_id,provider_request_id,operator,reason,evidence_sha256,verified_at,
      old_prompt_tokens,old_completion_tokens,old_cost_microusd,
      prompt_tokens,completion_tokens,cost_microusd)
    SELECT u.request_id,?2,?3,?4,?5,?6,u.prompt_tokens,u.completion_tokens,u.cost_microusd,
      ?7,?8,CAST((?7*r.input_price+?8*r.output_price+999999)/1000000 AS INTEGER)
    FROM usage u JOIN reservations r ON r.request_id=u.request_id
    WHERE u.request_id=?1 AND u.usage_missing=1 AND r.status='settled'
      AND r.input_price>0 AND r.output_price>0
      AND ?7*r.input_price+?8*r.output_price<=9007199253740991
      AND ?7+?8<=9007199254740991
    ON CONFLICT(request_id) DO NOTHING
    RETURNING request_id`,
    parameters: [record.requestId, record.providerRequestId, record.operator, record.reason,
      record.evidenceSha256, new Date().toISOString(), record.promptTokens, record.completionTokens],
  };
}
