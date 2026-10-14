# Bimax Mobile — PROMPT-18: standalone phone chat (first visible product)

Copy everything below the line into Antigravity as one prompt.

---

## Background

The AI gateway is LIVE at `https://bimax-gateway.sid7vish.workers.dev` and verified end-to-end (auth, rate limit, quota, allowlist, NVIDIA routing, SSE streaming, D1 metering). The phone app (`apps/mobile`, Expo Router SDK 53) has the trust/transport plane (pairing, approvals, relay) but **zero chat UI** — no login, no message renderer, no composer, no history. This prompt builds the first thing a user ever sees: a ChatGPT-style chat experience that works standalone through the gateway, no laptop required.

The renderer + composer are the product differentiator. They must be genuinely better than ChatGPT's — not a placeholder chat UI. Sid will judge this visually.

## Step 0 — Supabase project (needs Sid)

If `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` are not already available to you, STOP and ask Sid to: (1) create a Supabase project, (2) enable Google + GitHub OAuth providers and Email OTP in Auth settings, (3) paste you the project URL and anon key. Do not proceed with auth code until you have them. Never commit these values — they go in `.env` (gitignored) and Expo public env vars.

## Exact work

### A. Supabase auth in the app

1. Add `@supabase/supabase-js`, `expo-auth-session`, `expo-web-browser`, `expo-crypto` to `apps/mobile`. Create `lib/supabase.ts`: client from public env vars, session persisted via `expo-secure-store` (never AsyncStorage for tokens).
2. Build `app/login.tsx`: three sign-in options — **Google**, **GitHub** (via `supabase.auth.signInWithOAuth`, PKCE, redirect back into the app), and **Email + OTP** (6-digit code screen). Handle loading, error, and already-signed-in (redirect to chat) states.
3. Auth gate: unauthenticated users always land on `app/login.tsx`. Add sign-out in the chat settings/menu.

### B. Gateway auth bridge (Supabase JWT)

The gateway currently accepts 64-hex Bearer keys (`verifyAuth` in `apps/gateway/src/auth.ts`). Add Supabase JWT verification ALONGSIDE it — the seam comment in `auth.ts` anticipates exactly this. Do not break the existing Bearer path (tests depend on it).

1. In `apps/gateway`, add `jose` and verify RS256 JWTs against the Supabase JWKS (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`), caching the key set. New env var: `SUPABASE_URL` (secret-adjacent config, set via `wrangler secret put` on the live worker after Sid approves — do NOT commit it).
2. Routing: token with 3 dot-separated segments → Supabase JWT path (`user_id` = JWT `sub`); 64-hex → existing Bearer path. Invalid/expired JWT → 401 `invalid_api_key`, same shape as today.
3. Tests in `apps/gateway/test/`: valid JWT → authenticated as `sub`; wrong signature → 401; expired → 401; all existing Bearer tests still green. Use a static test JWKS (generate once in the test file), never the live Supabase project.

### C. Gateway streaming client

Create `apps/mobile/lib/gateway.ts`:

1. `streamChat({ model, messages, signal })`: POST to `{GATEWAY_URL}/v1/chat/completions` with `Authorization: Bearer <supabase access token>`, `stream: true`. Parse SSE (`data:` lines, `[DONE]` terminator), yielding `{ reasoning?, content? }` deltas — tonight's live smoke test proved reasoning models stream `reasoning_content` deltas, so handle both.
2. `getUsage()`: GET `/v1/usage`, returns `{ tokensUsed, tokenBudget, resetAt }` for a usage footer.
3. `GATEWAY_URL` from env config, defaulting to the live worker URL. Map aborts (`AbortController`) to a user-visible "stopped" state.

### D. Chat UI — the differentiator

Routes (Expo Router): conversation list as the post-login home, `chat/[id].tsx` for a conversation.

**Message renderer** (`components/Message.tsx` and friends). Requirements, all mandatory:

1. Full Markdown: headings, bold/italic/strikethrough, nested bullet + numbered lists, tables, blockquotes, inline code, hr.
2. Fenced code blocks: header row with language label (left) + tap-to-copy button (right, shows checkmark feedback); syntax highlighting for at least js/ts, python, bash, json, sql, html, css, go, rust, java; long lines scroll horizontally, never wrap-break the layout.
3. Reasoning blocks: collapsible "Thinking" section (collapsed by default once the answer starts), never dumped as raw text.
4. Streaming: tokens append without re-rendering the whole message — no flicker, no list jumping. Auto-scroll pins to bottom unless the user scrolled up (>100px), in which case show a "jump to latest" pill.
5. Typography: 16px base, 1.5 line height, clear heading scale, generous spacing. Apple-like cleanliness. Timestamps subtle. Failed message → inline retry button.

**Composer** (`components/Composer.tsx`): multiline input growing to 5 lines then scrolling; model picker (`deepseek-chat`, `qwen-plus`, `qwen-turbo`, `openai/gpt-oss-20b` — note the last is staging-only); attach button; send enabled only with non-empty text; while streaming, send becomes a stop button. Hitting send must feel instant (message appears immediately, streams in).

### E. Local history

`expo-sqlite` via `lib/chat-store.ts`: `conversations(id, title, model, created_at, updated_at)`, `messages(id, conversation_id, role, content, reasoning, created_at)`. Conversation list shows title (first user message, truncated) + updated time. Deleting a conversation deletes its messages. No cloud sync in v1 — local only, offline-capable.

### F. Attachments (v1 seam)

`expo-document-picker` + `expo-image-picker`: attach button opens picker, file chip appears in composer, text files (`.txt/.md/.json/.csv`, <200KB) are inlined into the sent message; anything else attaches as a labeled reference the model can't read yet. Image/vision ingest is PROMPT-19's job — leave a clean `ingestFile()` seam in `lib/attachments.ts` for it.

## SCOPE — DO NOT DO

- Do NOT touch the trust plane (`lib/crypto`, `lib/e2e`, `lib/relay`, `lib/session`, `app/pair.tsx`, `app/approvals.tsx`). Chat is standalone; laptop remote control is PROMPT-16's job.
- Do NOT implement any metering, quota, or usage enforcement in the client. That lives on the gateway only. The client may *display* `/v1/usage` numbers, never compute or enforce them.
- Do NOT build the PROMPT-19 ingest pipeline (PDF/OCR/vision). Text inline + seam only.
- Do NOT add Supabase tables/RLS for chat history. Local SQLite only.
- Do NOT commit any secrets, keys, or `.env` files.

## Acceptance commands

```
cd apps/gateway && npx tsc --noEmit && npm test
cd ../mobile && npx tsc --noEmit
```

All green. Then the live pass (Sid runs on Expo Go against the LIVE worker): sign in with Google → new chat → send "say hi" on `openai/gpt-oss-20b` → response streams with no jank → code-block test message renders highlighted with working copy button → `/v1/usage` ticks up.

## RETURN FOR REVIEW

1. Diffs of every new/changed file (mobile + gateway), or a file list with line counts if too large to paste.
2. Full terminal output of the acceptance commands.
3. Screenshots or a screen recording of: login screen, streaming chat, a code block with highlighting, the composer. Sid judges the visuals — do not skip this.
4. Explicit confirmation of every SCOPE item (what was NOT touched).
5. Any place where you need Sid (Supabase dashboard values, OAuth consent screens) — list them exactly.
