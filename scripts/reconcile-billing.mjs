#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { reconciliationStatement } from "../apps/gateway/src/billing-reconciliation.ts";

const [command, ...args] = process.argv.slice(2);
const remote = args.includes("--remote");
const target = remote ? "--remote" : "--local";
const cwd = fileURLToPath(new URL("../apps/gateway", import.meta.url));
const literal = (value) => typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
function execute(sql) {
    const raw = execFileSync(process.execPath, [
      fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
      "d1", "execute", "bimax_gateway", target, "--command", sql, "--json",
    ], { cwd, encoding: "utf8", env: { ...process.env, CI: "true" }, stdio: ["ignore", "pipe", "pipe"] });
    const results = JSON.parse(raw);
    if (!Array.isArray(results) || results.some((result) => !result.success)) throw new Error("D1 query failed");
    return results.flatMap((result) => result.results ?? []);
}

try {
  if (command === "list") {
    console.log(JSON.stringify({ target, estimates: execute(`SELECT u.request_id,u.model,u.created_at,
      u.prompt_tokens,u.completion_tokens,u.cost_microusd FROM usage u
      WHERE u.usage_missing=1 ORDER BY u.created_at LIMIT 100`),
      unlinkedLegacyRows: execute("SELECT count(*) AS count FROM usage WHERE request_id IS NULL") }, null, 2));
  } else if (command === "review" || command === "apply") {
    const evidencePath = args[args.indexOf("--evidence") + 1];
    if (!args.includes("--evidence") || !evidencePath || evidencePath.startsWith("--"))
      throw new Error("Supply --evidence /path/to/reviewed-provider-record.json");
    const raw = readFileSync(evidencePath);
    if (raw.length > 65536) throw new Error("Evidence record exceeds 64 KiB");
    const record = { ...JSON.parse(raw), evidenceSha256: createHash("sha256").update(raw).digest("hex") };
    const statement = reconciliationStatement(record);
    const before = execute(`SELECT u.*,r.input_price,r.output_price,r.status AS reservation_status
      FROM usage u JOIN reservations r ON r.request_id=u.request_id WHERE u.request_id=${literal(record.requestId)}`);
    if (before.length !== 1) throw new Error("No linked usage record; legacy rows need independent investigation");
    const current = before[0];
    const numerator = record.promptTokens * current.input_price + record.completionTokens * current.output_price;
    if (!Number.isSafeInteger(numerator) || numerator > Number.MAX_SAFE_INTEGER - 999999 ||
        !Number.isSafeInteger(record.promptTokens + record.completionTokens) || current.input_price <= 0 || current.output_price <= 0)
      throw new Error("Usage or original pricing exceeds supported bounds");
    if (command === "review") {
      console.log(JSON.stringify({ target, evidence: record, current, proposedCostMicrousd: Math.ceil(numerator / 1000000),
        eligible: current.usage_missing === 1 && current.reservation_status === "settled", applied: false }, null, 2));
    } else {
      // Quote numbered bindings as data. No shell evaluates the generated SQL or user fields.
      execute(statement.sql.replace(/\?(\d+)/g, (_match, number) => literal(statement.parameters[Number(number) - 1])));
      const receipt = execute(`SELECT * FROM billing_reconciliations WHERE request_id=${literal(record.requestId)}`)[0];
      if (!receipt || receipt.evidence_sha256 !== record.evidenceSha256 ||
          receipt.prompt_tokens !== record.promptTokens || receipt.completion_tokens !== record.completionTokens)
        throw new Error("No correction applied, or request was already reconciled using different evidence");
      console.log(JSON.stringify({ target, receipt }, null, 2));
    }
  } else {
    throw new Error("Usage: node scripts/reconcile-billing.mjs list|review|apply [--remote] [--evidence FILE]");
  }
} catch (error) {
  // Child errors can contain SQL/identity data; retain only the intentional operator-facing message.
  console.error(error?.status !== undefined ? "Wrangler failed; verify authentication, database and migrations." : error.message);
  process.exitCode = 1;
}
