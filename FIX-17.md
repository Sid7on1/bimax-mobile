# Bimax Mobile — FIX-17: gateway v1 review fixes (fail-open billing, observability)

Copy everything below the line into Antigravity as one prompt.

**Work location: `/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/`** — all paths below are relative to the repo root.

---

Background: Line-by-line review of the PROMPT-17 gateway. REVISION 2026-10-14:
the auth crash is FIXED (Node XOR fallback added to `timingSafeEqualStrings`,
verified on disk; `npm test` 19/19 green for real; smoke test proves the full
path). What remains is one blocker and four should-fix issues. The gateway is
NOT approved for deploy until this FIX passes.

**Read these before writing any code:**
`apps/gateway/src/{auth,index,providers,quota,ratelimit}.ts`,
`apps/gateway/test/{quota,allowlist}.test.ts`.

## BLOCKER — billing guard fails OPEN on D1/KV errors

`src/quota.ts`: if the D1 usage SUM throws, `tokensUsed` stays 0 →
`allowed: true`. `src/ratelimit.ts`: KV read/write throw → allowed. During a
D1/KV outage this is unlimited free usage billed to Sid's provider keys. For
a billing guard the safe default is fail-CLOSED.

Fix:

1. `checkQuota`: if EITHER D1 query throws, return
   `{ allowed: false, tokensUsed: 0, tokenBudget: budget, resetAt, error: "unavailable" }`
   and `console.error` loudly. Add `error: "ok" | "exceeded" | "unavailable"`
   to `QuotaStatus` (default `"ok"`; set `"exceeded"` when over budget).
2. In `src/index.ts`, map `error === "unavailable"` to
   `429 { error: { code: "quota_unavailable", message: "Usage check temporarily unavailable — try again shortly" } }`.
   Keep `quota_exceeded` for the over-budget case. No upstream fetch in either
   429 path.
3. `checkRateLimit`: on KV failure, keep fail-OPEN (availability over abuse
   protection for v1) but `console.error` loudly. Document the choice in a
   comment.
4. Add a test: D1 mock that throws on the usage query → `checkQuota` returns
   `allowed: false, error: "unavailable"`; `worker.fetch` with that mock →
   429 `quota_unavailable` and `fetch` (upstream) never called.

## SHOULD-FIX 1 — upstream failures are silent (ops blind spot)

`fetchUpstream` converts every upstream failure to a scrubbed 502 but logs
NOTHING. When a provider key expires or DeepSeek/Qwen is down, there is zero
signal. Add `console.error("[upstream] ${provider} failed: HTTP ${status}")`
on non-ok and on network exception (provider name + status ONLY — never the
key, never request bodies). The client-facing 502 stays scrubbed.

## SHOULD-FIX 2 — CORS reflects any Origin

`getCorsHeaders` returns `origin || "*"` with no validation. Fix: reflect
the Origin ONLY if it matches `/^(https?:\/\/|exp:\/\/|exps:\/\/)/`;
otherwise return `"*"`. (No `Allow-Credentials` is sent, so exploitability
is low — this is hygiene, not an active hole.)

## SHOULD-FIX 3 — SSE extractor drops the trailing partial line

`extractUsageFromSSE` breaks on `done` without processing the leftover
`buffer`. If a provider's final usage chunk is not `\n\n`-terminated, the
usage object is lost → `usage_missing: 1`, under-metering. Fix: after the
read loop, run the remaining buffer through the same line-parsing logic once.
Add a test: usage chunk WITHOUT trailing newlines → tokens still extracted.

## SHOULD-FIX 4 — unguarded `upstreamRes.json()`

Non-streaming path: `await upstreamRes.json()` throws on a non-JSON 200 →
unhandled → Worker 500. Wrap in try/catch → 502 `bad_gateway` (scrubbed).

## SHOULD-FIX 5 — no happy-path test

No test drives `worker.fetch` end-to-end (auth → rate limit → quota →
upstream → D1 row). Add one: stub global `fetch` to return a non-streaming
JSON body with `usage: {prompt_tokens: 10, completion_tokens: 5}`, call
`worker.fetch` with a valid key, assert 200, assert the mock D1 has exactly
one `usage` row with 10/5, and assert `GET /v1/usage` then reports
`tokensUsed: 15`. (This is the path that actually spends money — it must be
covered.)

## NITS (do all — small)

1. `src/auth.ts`: delete the dead double-hash block in `verifyAuth` (the
   second `sha256Hex` + `timingSafeEqualStrings` call compares a hash to
   itself — always true) and its misleading "per specification" comment.
   Keep `sha256Hex`, keep the `verifyAuth` signature stable (PROMPT-18 seam).
   Keep the XOR fallback inside `timingSafeEqualStrings` only if it is still
   referenced after the deletion; otherwise delete the function too and
   remove its now-dead test in `test/auth.test.ts` (replace with a KV
   hit/miss test if not already covered).
2. `vitest.config.ts`: delete the pointless `css.postcss.plugins: []` block.
3. `package.json`: the `deploy` script runs bare `wrangler deploy` — a footgun
   against the dry-run-only rule. Change it to `wrangler deploy --dry-run`
   and add `deploy:live` with a `# DANGER: production` comment.
4. `src/index.ts` Step F: the `!upstreamRes.ok` branch re-wraps an already-
   scrubbed 502 from `fetchUpstream` — add a comment explaining that
   `fetchUpstream` NEVER returns a raw upstream error (it pre-scrubs), so
   this branch only re-adds CORS headers.

## SCOPE — DO NOT DO

- Do NOT run `wrangler deploy` (dry-run only). No secrets in the repo.
- Do NOT touch anything outside `apps/gateway/` (no `apps/*`, no
  `packages/*`, no `/Users/vishsiddharth/Bimax`).
- No new endpoints, no new models, no Supabase (PROMPT-18).
- No TODOs in the request path.

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/gateway && npx tsc --noEmit` → zero errors
2. `npm test` → ALL suites PASS (must be real — full output is the proof)
3. `npx wrangler deploy --dry-run` → success
4. `grep -rn "quota_unavailable" src/ test/ | head -5` → hits (fail-closed path exists)
5. Repeat the PROMPT-17 acceptance #4 smoke (mock upstream, SSE curl, D1 row,
   `/v1/usage`) → still works end to end

## RETURN FOR REVIEW (paste all four)

1. The diff of `src/quota.ts`, `src/ratelimit.ts`, `src/index.ts`,
   `src/providers.ts` (logging), `src/auth.ts` (nit 1)
2. The new/changed tests IN FULL (quota-unavailable test, SSE trailing-buffer
   test, happy-path test)
3. The FULL terminal output of acceptance commands 1–5
4. Explicit confirmation of each SCOPE item
