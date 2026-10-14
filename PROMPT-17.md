# Bimax Mobile — PROMPT-17: AI gateway v1 (Cloudflare Worker — provider keys, metering, quotas, streaming chat)

Copy everything below the line into Antigravity as one prompt.

**Work location: `/Users/vishsiddharth/Desktop/bimax-mobile`** — new app `apps/gateway/`. All paths below are relative to that repo. (PROMPT-16 stays reserved for the phone chat UI; it is still gated on FIX-16's engine wiring.)

---

Background: Bimax is a full app like ChatGPT — desktop + phone as first-class
clients of the same models. The business model: subscriber pays ₹200, roughly
₹100 of that funds model usage through Sid's provider account. So ONE gateway
holds the provider keys and meters per-user usage across both clients, with
quotas and fair-use caps so heavy users can't blow past the budget. Launch
models: DeepSeek + Qwen. This prompt builds gateway v1: an OpenAI-compatible
`POST /v1/chat/completions` (streaming + non-streaming), bearer-key auth (stub
seam — PROMPT-18 replaces it with Supabase JWT), per-user token metering in D1,
monthly quota enforcement, and per-minute rate limits. PROMPT-18 will build the
standalone phone chat on top of this API.

**Read these before writing any code:** `apps/cloud-relay/wrangler.toml`,
`apps/cloud-relay/package.json`, and `apps/cloud-relay/src/*` (the existing
Worker — copy its toolchain conventions: wrangler version, tsconfig style,
dev/test scripts). Also read the root `package.json` for the workspace layout.

## 1. Scaffold `apps/gateway/`

- `package.json`, `tsconfig.json`, `wrangler.toml`, `vitest.config.ts`,
  `schema.sql`, `src/index.ts`,
  `src/{auth.ts, providers.ts, metering.ts, quota.ts, ratelimit.ts}`,
  `test/{auth,quota,ratelimit,streaming,allowlist}.test.ts`,
  `scripts/mint-key.mjs`.
- `wrangler.toml`: worker name `bimax-gateway`; one D1 database
  (`bimax_gateway` — create with `wrangler d1 create`; local dev uses `--local`);
  two KV namespaces: `GATEWAY_KEYS` (key-hash → userId) and
  `GATEWAY_RATELIMIT` (rate-limit counters). Env vars: `ALLOWED_MODELS`
  (default `deepseek-chat,qwen-plus,qwen-turbo`), `DEFAULT_MONTHLY_TOKENS`,
  `RATE_LIMIT_PER_MIN` (default `30`). Secrets (never in code, never in the
  repo): `DEEPSEEK_API_KEY`, `QWEN_API_KEY` — document
  `wrangler secret put <NAME>` in a `README.md`.

## 2. Provider layer — `src/providers.ts`

- Two upstreams, both OpenAI-compatible `POST /chat/completions`:
  - DeepSeek: `https://api.deepseek.com/chat/completions`
  - Qwen (DashScope OpenAI-compatible):
    `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`
- The gateway maps `model` → upstream internally. REJECT any model not in
  `ALLOWED_MODELS` with 400 BEFORE any network call. Never accept a
  client-supplied base URL or API key — the client sends only `model`.
- When `stream: true`, always inject `stream_options: { include_usage: true }`
  so token counts arrive in the final SSE chunk (both providers support this
  on their OpenAI-compatible endpoints; if one doesn't, the metering fallback
  in §5 covers it).
- Provider keys come from `env` secrets only. Never log keys, the
  `Authorization` header, or prompt contents. Upstream errors map to 502 with
  a scrubbed OpenAI-shaped body (status preserved, internals stripped).

## 3. API — `src/index.ts`

- `POST /v1/chat/completions` — OpenAI-compatible body. Validate: `model` is a
  string in the allowlist; `messages` is a non-empty array. Pass through other
  fields (`temperature`, `max_tokens`, etc.) untouched.
- `stream: true`: pipe the upstream SSE bytes straight through via
  `TransformStream`, teeing the stream to capture the final `usage` chunk.
  After the stream closes, write the metering row. If the upstream dies
  mid-stream, close cleanly — the client keeps what arrived; meter whatever
  `usage` was captured (possibly zeros, flagged per §5).
- `stream: false` (or absent): await upstream JSON, record `usage`, return it.
- `GET /health` → `{ "ok": true }` (no auth).
- `GET /v1/usage` (auth required) → `{ tokensUsed, tokenBudget, resetAt }`
  for the calling key's current month. The app will show this to the user.
- All errors OpenAI-shaped: `{ error: { message, type, code } }`.
- CORS: allow the Expo app. For v1, reflect the request `Origin` when it is
  `http`/app-scheme, with a comment noting PROMPT-18 will pin the allowlist.

## 4. Auth — `src/auth.ts` (seam for PROMPT-18)

- `Authorization: Bearer <key>`. Keys are 32 random bytes hex-encoded;
  store `SHA-256(key)` → `userId` in `GATEWAY_KEYS`. Compare with
  `crypto.subtle.timingSafeEqual`. Missing/invalid → 401.
- Expose `verifyAuth(request, env): Promise<{ userId: string } | null>` and
  add a comment: PROMPT-18 adds Supabase JWT verification ALONGSIDE this
  function — keep the signature stable.
- `scripts/mint-key.mjs <userId>`: generates a key, prints the key (show ONCE)
  and the exact `wrangler kv:key put --binding=GATEWAY_KEYS <sha256> <userId>`
  command to run. Document that production issuance moves to Supabase signup
  in PROMPT-18.

## 5. Metering — `src/metering.ts` + `schema.sql`

- D1 table: `usage(id INTEGER PRIMARY KEY, user_id TEXT, model TEXT,`
  `prompt_tokens INTEGER, completion_tokens INTEGER, created_at TEXT)`.
- One row per completed request, token counts from the provider's `usage`
  object ONLY. If `usage` is absent, store zeros and log a warning
  (include a `notes` column or a `usage_missing INTEGER` flag — your choice,
  document it).
- The metering write must NEVER fail the client response: wrap it so a D1
  error is logged and the response still completes. (Quota is the enforcement
  point; metering is best-effort observability.)

## 6. Quota — `src/quota.ts`

- D1 table: `quotas(user_id TEXT PRIMARY KEY, monthly_tokens INTEGER)`.
- Default budget from `DEFAULT_MONTHLY_TOKENS` env. Pick the default and SHOW
  YOUR MATH in the README: start from ~₹100/month, use current published
  DeepSeek + Qwen per-1M-token prices, assume a blended input/output mix, and
  convert to a token number. Env-var precisely because pricing moves.
- Enforcement happens BEFORE the provider call: `SUM(prompt_tokens +
  completion_tokens)` for this user since the 1st of the month (UTC); if
  `used >= budget` → `429 { error: { code: "quota_exceeded", message } }` and
  NO upstream fetch is attempted. `resetAt` = 1st of next month, UTC.
- Document the accepted v1 limitation in a comment: check-then-act without
  pre-reservation (two concurrent requests can both pass); v2 will reserve an
  estimate. Do not build the reservation now.

## 7. Rate limit — `src/ratelimit.ts`

- KV `GATEWAY_RATELIMIT`, fixed window: key `rl:<keyHash>:<YYYYMMDDHHMM>`,
  increment with 90s expiration, limit `RATE_LIMIT_PER_MIN`. Exceeded → 429
  with a `Retry-After: 60` header.

## 8. Tests — `test/*.test.ts` (vitest, ZERO real network)

Mock `fetch`, D1, and KV with in-memory fakes:

1. **auth**: wrong key → null; missing header → null. (Timing-safety is
   structural — assert `timingSafeEqual` is the comparison used, via a code
   comment reference in the test name if needed; do not over-engineer.)
2. **quota**: used < budget passes; used >= budget → 429 and `fetch` was never
   called; month-boundary resets (Dec 31 → Jan 1); per-user isolation.
3. **ratelimit**: N requests pass, N+1 → 429; window rollover passes again;
   per-key isolation.
4. **streaming**: feed a fake SSE byte stream ending with a `usage` chunk
   through the tee logic → assert captured `{prompt_tokens, completion_tokens}`
   and that all `data:` chunks reached the client side unaltered.
5. **allowlist**: disallowed model → 400 with `fetch` never called;
   client-supplied `base_url`/`api_key` fields are stripped, never forwarded.

## SCOPE — DO NOT DO

- Do NOT run `wrangler deploy` (use `--dry-run` only). No production secrets
  anywhere in the repo.
- Do NOT touch `apps/desktop-responder/*`, `packages/protocol/*`,
  `apps/mobile/*`, `apps/relay`, `apps/cloud-relay`, or
  `/Users/vishsiddharth/Bimax`.
- No Stripe/billing, no Supabase, no signup UI, no admin dashboard — PROMPT-18.
- No models beyond DeepSeek + Qwen. No client-supplied provider keys, ever.
- No TODOs in the request path.

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/gateway && npm install && npx tsc --noEmit` → zero errors
2. `npm test` → all vitest suites PASS
3. `npx wrangler deploy --dry-run` → success
4. Local smoke with mock upstream: start `MOCK_UPSTREAM=1 npx wrangler dev
   --local`, mint a test key, then:
   `curl -N -H "Authorization: Bearer <key>" -H "Content-Type: application/json"`
   `-d '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}'`
   `http://localhost:8787/v1/chat/completions` → SSE `data:` chunks arrive;
   then `npx wrangler d1 execute bimax_gateway --local --command "SELECT
   user_id, model, prompt_tokens, completion_tokens FROM usage"` → one row;
   then `curl -H "Authorization: Bearer <key>"`
   `http://localhost:8787/v1/usage` → numbers match the row.
5. Quota smoke: restart dev with `DEFAULT_MONTHLY_TOKENS=10`, repeat the chat
   call until the budget is exhausted → next call returns 429
   `quota_exceeded` and no upstream fetch is attempted for it.

## RETURN FOR REVIEW (paste all four)

1. The file list of `apps/gateway/` + `schema.sql` IN FULL
2. `src/index.ts`, `src/quota.ts`, and `src/auth.ts` IN FULL
3. The FULL terminal output of acceptance commands 1–5
4. Explicit confirmation of each SCOPE item + the monthly-token math used for
   the default budget
