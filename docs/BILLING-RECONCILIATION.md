# Operator billing reconciliation

Use Node 24 and migration `0005_billing_reconciliation_audit.sql`. Wrangler supplies privileged operator access; this workflow has no mobile/public HTTP endpoint. Commands default to the local development database unless `--remote` is specified.

1. Run `node scripts/reconcile-billing.mjs list --remote` to inspect up to 100 estimates and the count of unlinked historical rows.
2. Match the gateway request ID (`X-Request-Id`) to verified provider usage/billing evidence. Investigate ambiguous matches; a disconnected stream does not prove zero usage. Retain the provider export privately.
3. Create a private JSON review record with `requestId`, `providerRequestId`, `promptTokens`, `completionTokens`, `operator` and `reason`. Use verified integer counts and an identifiable operator. Keep the provider evidence with this record. The script hashes the review record; it does not authenticate provider exports or prove the match for you.
4. Run `node scripts/reconcile-billing.mjs review --remote --evidence /absolute/private/review.json`. Check the original price snapshot, account/request match, old charge, proposed charge and eligibility. Review makes no change.
5. Replace `review` with `apply` to commit that correction, then retain its receipt with the evidence. This is an explicit billing mutation.

One INSERT records the evidence hash, provider ID, operator, reason, timestamp and old/new charge. A trigger corrects usage and the existing trigger adjusts user/global budgets in the same transaction. Failure rolls back the correction and audit entry. An identical repeat returns the existing receipt; different evidence/counts fail. Audit records reject UPDATE/DELETE. This is a database audit trail, not protection against a privileged administrator replacing the schema.

The internal helper is now `reconcileUsage(env, requestId, promptTokens, completionTokens, evidence)`. Evidence requires `providerRequestId`, `operator`, `reason` and `evidenceSha256`. It uses the same SQL as the CLI and must never accept client-controlled billing decisions.

On 16 October 2026, live D1 contained no new-format estimates and 19 historical rows without reservation IDs or price snapshots. They remain unchanged and need independent provider/accounting investigation. This workflow refuses to invent missing linkage or prices. The `artifacts/audit/billing-cli-*` receipts demonstrate synthetic local review/apply/repeat only.
