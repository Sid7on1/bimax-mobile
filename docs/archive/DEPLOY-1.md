# Bimax Mobile — DEPLOY-1: ship the AI gateway to Cloudflare (staging)

Copy everything below the line into Antigravity as one prompt.

**Work location: `/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/`** — all paths below are relative to the repo root.

---

Background: The gateway (PROMPT-17 + FIX-17 + PROMPT-23) is code-reviewed and approved.
It has only ever run on localhost. This deploys it to a Cloudflare
workers.dev URL so PROMPT-18 has a real backend to build against and the
production config (D1, KV, secrets) gets proven while nothing matters yet.
This is NOT a launch — no users, no announcement, staging only.

## 0. Preconditions

1. `cd apps/gateway && npx wrangler whoami` → must show a logged-in
   Cloudflare account. If not: run `npx wrangler login`, tell Sid to complete
   the browser OAuth step, then re-run `whoami`.
2. Sid must have his NVIDIA NIM API key ready (from `/Users/vishsiddharth/Desktop/api keys/nvidia_keys.txt`).
   Do NOT ask him to paste it in chat — `wrangler secret put` prompts interactively
   and the values never touch the repo.

## 1. Create the D1 database

`npx wrangler d1 create bimax_gateway` → copy the `database_id` from the
output. (If it already exists, use `npx wrangler d1 list` and take that id.)

## 2. Create the KV namespaces

```
npx wrangler kv:namespace create GATEWAY_KEYS
npx wrangler kv:namespace create GATEWAY_RATELIMIT
```

Copy both namespace ids from the outputs.

## 3. Wire the real IDs into `wrangler.toml`

Replace the three placeholder ids (the `00000000-0000-...` ones) with the real
`database_id` and the two KV namespace ids.

For this staging deploy, temporarily append the NIM test model id to `ALLOWED_MODELS`
in `wrangler.toml [vars]`:
```toml
ALLOWED_MODELS = "deepseek-chat,qwen-plus,qwen-turbo,meta/llama-3.1-8b-instruct"
```
*(Staging-only: this entry will be removed before production launch. The committed default stays DeepSeek + Qwen).*

VERIFY (non-negotiable): `grep -n "MOCK_UPSTREAM" wrangler.toml` must return
NOTHING. Mock mode lives in `.dev.vars` (local dev only — deploy ignores it).
If the line is present in `wrangler.toml`, DELETE it: deploying with it serves
canned mock responses to every user while metering fake usage.

## 4. Apply the schema (local + remote)

```
npx wrangler d1 execute bimax_gateway --local --file=./schema.sql
npx wrangler d1 execute bimax_gateway --remote --file=./schema.sql
```

Verify remote:
`npx wrangler d1 execute bimax_gateway --remote --command "SELECT name FROM sqlite_master WHERE type='table'"`
→ must list `usage` and `quotas`.

## 5. Set the provider secrets

Primary secret for this staging deploy (using NVIDIA NIM):
```
npx wrangler secret put NVIDIA_API_KEY
```
Optional for now (launch providers; set when credits are purchased):
```
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put QWEN_API_KEY
```

All prompt interactively — Sid types/pastes when asked. Never echo the
values, never write them to any file, never put them in chat.

## 6. Deploy (staging)

`npm run deploy:live` → capture the `https://bimax-gateway.<account>.workers.dev`
URL from the output. Check the deploy output's Vars list: `MOCK_UPSTREAM`
must NOT appear.

## 7. Live smoke test (spends a few real tokens — negligible)

1. `node scripts/mint-key.mjs deploy_test` → copy the API key and its hash.
2. Store it in the REMOTE KV (no `--local` flag):
   `npx wrangler kv:key put --binding=GATEWAY_KEYS "<hash>" "deploy_test"`
3. Stream a real completion against the LIVE url using NVIDIA NIM:
   `curl -N https://<worker-url>/v1/chat/completions -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"model":"meta/llama-3.1-8b-instruct","messages":[{"role":"user","content":"say hi"}],"stream":true}'`
   → must return REAL SSE chunks from NVIDIA NIM. Assert the chunk ids do NOT start with
   `chatcmpl-mock-` (that prefix means mock mode leaked into production —
   stop and report immediately).
4. `npx wrangler d1 execute bimax_gateway --remote --command "SELECT user_id, model, prompt_tokens, completion_tokens FROM usage"`
   → exactly one row for `deploy_test` with real token counts.
5. `curl -s https://<worker-url>/v1/usage -H "Authorization: Bearer <key>"`
   → `tokensUsed` > 0, `tokenBudget` 4000000.
6. Negative checks: no `Authorization` header → 401; `"model":"gpt-4o"` →
   400 `model_not_allowed`.

## 8. Clean up

Delete the test key from remote KV:
`npx wrangler kv:key delete --binding=GATEWAY_KEYS "<hash>"`
(Alternatively keep it for PROMPT-18 development — note which you did.)
Optionally delete its usage row so PROMPT-18 starts from a clean ledger:
`npx wrangler d1 execute bimax_gateway --remote --command "DELETE FROM usage WHERE user_id='deploy_test'"`.

## SCOPE — DO NOT DO

- Do NOT edit anything under `src/`, `test/`, or `scripts/`. The ONLY file you
  may modify is `wrangler.toml`, and only the three id fields and staging model in step 3.
- Do NOT put secrets anywhere except `wrangler secret put`.
- Do NOT set up a custom domain, analytics, alerts, or CI. Staging
  workers.dev URL only.
- Do NOT share or announce the URL anywhere.

## ACCEPTANCE (paste the FULL terminal output)

1. `npx wrangler whoami` → logged in
2. Step 4 remote table check → `usage` and `quotas` present
3. `npm run deploy:live` → success; Vars list has no `MOCK_UPSTREAM`
4. Step 7 live smoke → real (non-mock) SSE, D1 row, `/v1/usage` > 0, 401 + 400 negatives pass
5. `grep -n "MOCK_UPSTREAM" wrangler.toml` → empty

## RETURN FOR REVIEW (paste all four)

1. The live workers.dev URL
2. The `wrangler.toml` diff (id fields only — confirm nothing else changed)
3. The FULL terminal output of acceptance commands 1–5
4. Explicit confirmation of each SCOPE item + whether the deploy_test key was
   kept or deleted
