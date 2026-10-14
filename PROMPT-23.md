# Bimax Mobile — PROMPT-23: NVIDIA NIM test upstream for the gateway

Copy everything below the line into Antigravity as one prompt.

**Work location: `/Users/vishsiddharth/Desktop/bimax-mobile/apps/gateway/`** — all paths below are relative to the repo root.

---

Background: Sid has NVIDIA NIM API keys in `/Users/vishsiddharth/Desktop/api keys/nvidia_keys.txt`.
For testing the gateway (local + DEPLOY-1 staging) he wants to use those instead of buying
DeepSeek credit right now. NVIDIA NIM is OpenAI-compatible
(`https://integrate.api.nvidia.com/v1/chat/completions`), so this is a small provider
addition. Product plan is UNCHANGED: DeepSeek + Qwen remain the launch providers; NIM is
the testing path only.

**Read first:** `apps/gateway/src/providers.ts` (`resolveUpstream`, `UPSTREAM_ENDPOINTS`,
`UpstreamConfig`), `apps/gateway/src/auth.ts` (`Env`), `apps/gateway/README.md`.

## 1. Add the NIM upstream — `src/providers.ts`

- Add `nvidia: "https://integrate.api.nvidia.com/v1/chat/completions"` to `UPSTREAM_ENDPOINTS`.
- Add `"nvidia"` to the `UpstreamConfig` provider union type.
- In `resolveUpstream`, add as the FIRST check (before the deepseek/qwen `startsWith` checks):
  `if (model.includes("/"))` → return `{ provider: "nvidia", url: UPSTREAM_ENDPOINTS.nvidia, apiKey: env.NVIDIA_API_KEY || "" }`.
  Why this rule and this order: NIM model ids always look like `org/model`
  (e.g. `meta/llama-3.1-8b-instruct`), while our first-party ids (`deepseek-chat`,
  `qwen-plus`, `qwen-turbo`) never contain `/`. The check must come first because
  e.g. `deepseek-ai/deepseek-r1`.startsWith("deepseek") would otherwise misroute to
  DeepSeek's endpoint with the wrong key.
- Missing-key and error behavior identical to the other providers (502 scrubbed,
  logged via the existing `[upstream]` logger). `stream_options.include_usage` injection
  stays as-is (harmless if NIM ignores it; the `usage_missing` fallback covers it).

## 2. Env + docs

- `src/auth.ts`: add `NVIDIA_API_KEY?: string` to `Env`.
- `apps/gateway/README.md`: document `npx wrangler secret put NVIDIA_API_KEY` and the
  routing rule (any model id containing `/` → NVIDIA NIM; testing path, not a launch
  provider).
- `wrangler.toml`: NO change (it's a secret, not a var). Double-check `MOCK_UPSTREAM`
  is still absent from it.

## 3. Tests — `test/`

- New test: with `ALLOWED_MODELS` including `meta/llama-3.1-8b-instruct` and stubbed
  global `fetch`, call `fetchUpstream({model: "meta/llama-3.1-8b-instruct", ...}, env)`
  (export it or test via `worker.fetch` — your choice) → assert `fetch` was called with
  url `https://integrate.api.nvidia.com/v1/chat/completions` and header
  `Authorization: Bearer <nvidia-test-key>`.
- New test: a model WITHOUT `/` (e.g. `deepseek-chat`) still routes to the DeepSeek
  URL as before (regression guard on the ordering).
- All existing tests stay green.

## 4. Update DEPLOY-1.md (same repo, repo root)

- Step 3: after wiring the real IDs, temporarily append the NIM model id to
  `ALLOWED_MODELS` in `wrangler.toml [vars]` for this staging deploy
  (e.g. `ALLOWED_MODELS = "deepseek-chat,qwen-plus,qwen-turbo,meta/llama-3.1-8b-instruct"`).
  Add a comment in DEPLOY-1.md that this entry is staging-only and gets removed before
  launch. The committed default stays DeepSeek + Qwen.
- Step 5 (secrets): add `npx wrangler secret put NVIDIA_API_KEY` as the primary key
  for this test deploy (interactive — Sid pastes when prompted). Mark the DeepSeek/Qwen
  `secret put` lines as optional-for-now.
- Step 7 (smoke test): use `"model":"meta/llama-3.1-8b-instruct"` instead of
  `"model":"deepseek-chat"`. If that exact model id is not available on Sid's NIM
  tier, use another instruct model from NIM (check via a quick curl against
  `https://integrate.api.nvidia.com/v1/models` with his key — do NOT guess blindly).
  The non-mock assertion (`chatcmpl-mock-` prefix must be absent) stays.

## SCOPE — DO NOT DO

- Do NOT change the committed default `ALLOWED_MODELS` permanently (stays
  `deepseek-chat,qwen-plus,qwen-turbo`; the NIM entry from step 4 is staging-only).
- Do NOT print the NIM key value anywhere — not in chat, not in files, not in logs.
  Refer to the file by name only.
- Do NOT touch `apps/desktop-responder/*`, `packages/protocol/*`, `apps/mobile/*`,
  `apps/relay`, `apps/cloud-relay`, or `/Users/vishsiddharth/Bimax`.
- Do NOT run `wrangler deploy` (dry-run only).

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/gateway && npx tsc --noEmit` → zero errors
2. `npm test` → all suites PASS
3. `npx wrangler deploy --dry-run` → success

## RETURN FOR REVIEW (paste all four)

1. The diff of `src/providers.ts`, `src/auth.ts`, `README.md`, `DEPLOY-1.md`
2. The new tests IN FULL
3. The FULL terminal output of acceptance commands 1–3
4. Explicit confirmation of each SCOPE item + which NIM model id the smoke test will use
