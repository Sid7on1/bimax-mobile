import type { Env } from "./auth";
import type { ChatCompletionRequest } from "./providers";
import { getMonthWindowUTC } from "./quota";
import { reconciliationStatement, type VerifiedUsage } from "./billing-reconciliation";
export interface Reservation {
  id: string;
  userId: string;
  model: string;
  tokens: number;
  cost: number;
  inputPrice: number;
  outputPrice: number;
  createdAt: string;
}
export function priceCost(
  prompt: number,
  completion: number,
  inputPrice: number,
  outputPrice: number,
): number {
  return Math.ceil((prompt * inputPrice + completion * outputPrice) / 1_000_000);
}
/** A single conditional INSERT serializes admission, including pending requests. */
export async function reserve(
  env: Env,
  userId: string,
  req: ChatCompletionRequest,
  requestId: string = crypto.randomUUID(),
): Promise<Reservation | null> {
  const prices = JSON.parse(env.MODEL_PRICES_JSON ?? "{}")[req.model];
  if (
    !prices ||
    !Number.isSafeInteger(prices.input) ||
    !Number.isSafeInteger(prices.output) ||
    prices.input <= 0 ||
    prices.output <= 0
  )
    throw new Error("Model pricing is not configured");
  // UTF-8 bytes conservatively bound tokenized input; include template/tool overhead.
  const input =
    new TextEncoder().encode(JSON.stringify(req)).length + req.messages.length * 32 + 1024;
  const output = req.max_tokens!;
  const record: Reservation = {
    id: requestId,
    userId,
    model: req.model,
    tokens: input + output,
    cost: priceCost(input, output, prices.input, prices.output),
    inputPrice: prices.input,
    outputPrice: prices.output,
    createdAt: new Date().toISOString(),
  };
  const month = getMonthWindowUTC(new Date(record.createdAt)).startOfMonthISO;
  const globalLimit = Number(env.GLOBAL_MONTHLY_MICROUSD);
  if (!Number.isSafeInteger(globalLimit) || globalLimit <= 0)
    throw new Error("Global spend limit is not configured");
  const row = await env.DB.prepare(
    `INSERT INTO reservations(request_id,user_id,month,model,tokens,microusd,input_price,output_price,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
    WHERE EXISTS (SELECT 1 FROM entitlements WHERE user_id=?2 AND status='active' AND expires_at>?9)
    AND (SELECT paused FROM billing_control WHERE id=1)=0
    AND (SELECT COUNT(*) FROM reservations WHERE user_id=?2 AND status='pending' AND created_at>?12)<2
    AND ?5 + COALESCE((SELECT tokens FROM budget_totals WHERE user_id=?2 AND month=?3),0)
      <= COALESCE((SELECT monthly_tokens FROM quotas WHERE user_id=?2),?10)
    AND ?6 + COALESCE((SELECT microusd FROM budget_totals WHERE user_id=?2 AND month=?3),0)
      <= (SELECT monthly_microusd FROM entitlements WHERE user_id=?2)
    AND ?6 + COALESCE((SELECT microusd FROM budget_totals WHERE user_id='*' AND month=?3),0) <= ?11
    RETURNING request_id`,
  )
    .bind(
      record.id,
      userId,
      month,
      req.model,
      record.tokens,
      record.cost,
      prices.input,
      prices.output,
      record.createdAt,
      Number(env.DEFAULT_MONTHLY_TOKENS ?? 4_000_000),
      globalLimit,
      new Date(Date.now() - 120_000).toISOString(),
    )
    .first();
  return row ? record : null;
}
/** Finalize every outcome. Unknown provider usage remains a conservative, reconcilable charge. */
export async function settle(
  env: Env,
  reservation: Reservation,
  usage: {
    promptTokens: number;
    completionTokens: number;
    usageMissing: boolean;
    rejected?: boolean;
  },
): Promise<void> {
  const estimated =
    !usage.rejected &&
    (usage.usageMissing ||
      !Number.isSafeInteger(usage.promptTokens) ||
      !Number.isSafeInteger(usage.completionTokens) ||
      usage.promptTokens < 0 ||
      usage.completionTokens < 0);
  const prompt = usage.rejected ? 0 : estimated ? reservation.tokens : usage.promptTokens;
  const completion = usage.rejected || estimated ? 0 : usage.completionTokens;
  const cost = usage.rejected
    ? 0
    : estimated
      ? reservation.cost
      : priceCost(prompt, completion, reservation.inputPrice, reservation.outputPrice);
  if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(prompt + completion))
    throw new Error("Invalid provider usage");
  if (!estimated && (prompt + completion > reservation.tokens || cost > reservation.cost))
    console.error("Provider exceeded reservation; actual usage recorded", reservation.id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO usage(user_id,model,prompt_tokens,completion_tokens,created_at,usage_missing,request_id,cost_microusd)
      SELECT user_id,model,?,?,?,?,request_id,? FROM reservations WHERE request_id=? AND status='pending'
      ON CONFLICT(request_id) DO NOTHING`,
    ).bind(prompt, completion, reservation.createdAt, estimated ? 1 : 0, cost, reservation.id),
    env.DB.prepare(
      "UPDATE reservations SET status='settled' WHERE request_id=? AND EXISTS(SELECT 1 FROM usage WHERE request_id=?)",
    ).bind(reservation.id, reservation.id),
  ]);
}

/** Operator-only reconciliation using verified provider records; never exposed to the phone. */
export async function reconcileUsage(
  env: Env,
  requestId: string,
  prompt: number,
  completion: number,
  evidence: Pick<VerifiedUsage, "providerRequestId" | "operator" | "reason" | "evidenceSha256">,
) {
  const statement = reconciliationStatement({
    ...evidence, requestId, promptTokens: prompt, completionTokens: completion,
  });
  await env.DB.prepare(statement.sql).bind(...statement.parameters).run();
  const receipt = await env.DB.prepare(
    "SELECT * FROM billing_reconciliations WHERE request_id=?",
  ).bind(requestId).first<{ evidence_sha256: string; prompt_tokens: number; completion_tokens: number }>();
  if (!receipt || receipt.evidence_sha256 !== evidence.evidenceSha256 ||
      receipt.prompt_tokens !== prompt || receipt.completion_tokens !== completion)
    throw new Error("Request is not an estimate or was reconciled with different evidence");
  return receipt;
}

/** Recover isolates terminated before finalization without leaving concurrency slots occupied. */
export async function finalizeExpired(env: Env) {
  const result = await env.DB.prepare(
    "SELECT * FROM reservations WHERE status='pending' AND created_at<? LIMIT 100",
  )
    .bind(new Date(Date.now() - 180_000).toISOString())
    .all<{
      request_id: string;
      user_id: string;
      model: string;
      tokens: number;
      microusd: number;
      input_price: number;
      output_price: number;
      created_at: string;
    }>();
  for (const row of result.results)
    await settle(
      env,
      {
        id: row.request_id,
        userId: row.user_id,
        model: row.model,
        tokens: row.tokens,
        cost: row.microusd,
        inputPrice: row.input_price,
        outputPrice: row.output_price,
        createdAt: row.created_at,
      },
      { promptTokens: 0, completionTokens: 0, usageMissing: true },
    );
}
