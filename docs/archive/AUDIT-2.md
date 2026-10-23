# Bimax — AUDIT-2: Adversarial Security Audit, Round 3

Copy everything below the line into the audit agent as one prompt.

---

## Background

Two security audits have already been completed on this repo:

1. **ChatGPT audit** (2026-10-15, `artifacts/audit/production-readiness-2026-10-15.md`) — found **F01–F15**.
2. **Muse 4-agent deep audit** (2026-10-15, `artifacts/audit/security-deep-audit-2026-10-15.md`) — found **BMA-01–BMA-28**.

**Your job: find what both audits missed.** You are round 3. Assume the first two audits were competent — your value is in what they overlooked, edge cases they didn't push, and attack chains they didn't combine.

**Hard rule: do NOT re-report any finding below.** If you find something that overlaps, cite the existing ID and move on. Duplicates will be rejected.

---

## Already found — do not re-report

### ChatGPT findings (F01–F15)
- **F01:** Mobile dispatcher accepts plaintext `approval_request`/`agent_status` (forged approvals accepted).
- **F02:** Chat data and device trust not scoped to signed-in account.
- **F03:** No subscription/entitlement check — any login gets full quota.
- **F04:** Rate limiter loses concurrent increments (KV race).
- **F05:** No atomic cost reservation; soft quota only.
- **F06:** Idempotency crash window — *likely already remediated* (write-ahead journal in current tree); verify before claiming.
- **F07:** Delivery/nonce/reconnect inconsistent (dropped packet breaks auth, no auto re-handshake).
- **F08:** Normal pairing can't discover approval-signing key.
- **F09:** Cloud relay has no admission control.
- **F10:** JWT omits issuer/audience/exp claim checks.
- **F11:** Noise handshake skips MixHash on empty prologue (spec deviation).
- **F12:** No upstream fetch timeout; phone stop doesn't stop provider spend.
- **F13:** Attachment UI promises more than it sends (filename only).
- **F14:** Only FakeEngine implements EnginePort (no real engine).
- **F15:** No CI, no staging/prod separation, ops unfinished.

### Muse deep-audit findings (BMA-01–BMA-28)
- **BMA-01 [High]:** No `max_tokens` cap — clients dictate output spend.
- **BMA-02 [High]:** `n` parameter not stripped — 10x spend multiplier.
- **BMA-03 [High]:** No request body size limit — worker OOM DoS.
- **BMA-04 [High]:** `parseAdvertisement` doesn't validate `relayUrl` — malicious QR → attacker relay.
- **BMA-05 [High]:** Desktop identity keys world-readable (0644).
- **BMA-06 [High]:** Silent RCE — no approval gate/indicator on remote commands.
- **BMA-07 [Med]:** `messages` array unbounded.
- **BMA-08 [Med]:** Quota admission size-blind.
- **BMA-09 [Med]:** `bimax://` OAuth interception risk (production).
- **BMA-10 [Med]:** Plaintext SQLite chat history.
- **BMA-11 [Med]:** `Math.random()` for security IDs — kill-switch neutering.
- **BMA-12 [Med]:** No TLS enforcement on relay URLs (mobile).
- **BMA-13 [Med]:** Attachment size trusts picker metadata — OOM.
- **BMA-14 [Med]:** Unbounded relay outbox (mobile).
- **BMA-15 [Med]:** TOFU pin poisoning — persistent DoS.
- **BMA-16 [Med]:** No instruction content policy.
- **BMA-17 [Med]:** Relay traffic-analysis metadata leaks.
- **BMA-18 [Med]:** `better-sqlite3` prebuilt binaries bypass lockfile integrity.
- **BMA-19–28 [Low]:** Unauthenticated nonce header; `deny` bypasses biometric; raw errors to UI; kill switch no local fallback; attacker filename to engine; MIME self-declared; no TLS enforcement (responder); `setTrustedPhone` trust-bypass primitive; `protocolVersion` not in hello signature; wildcard `@bimax/protocol` dep.

---

## Objective

Find **novel** vulnerabilities the first two audits missed. Target: minimum 10 new findings with file:line evidence. Quality over quantity — a single novel RCE or fund-draining bug beats ten nits.

---

## Methodology — industry standards to apply

You are expected to work to professional penetration-testing standards. Map your testing to these frameworks and **state which framework each finding was discovered under**:

### 1. OWASP Web Security Testing Guide (WSTG v4.2)
Apply to the gateway (`apps/gateway`). Specifically:
- **WSTG-ATHN / WSTG-ATHZ:** authentication and authorization testing — try every endpoint without auth, with malformed auth, with another user's token.
- **WSTG-INPV:** input validation — fuzz every JSON field: `model`, `messages[].content`, `temperature`, `top_p`, `stream`, `stream_options`. Try type confusion (string where number expected, array where object expected, `null`, nested objects 100 deep).
- **WSTG-ERRH:** error handling — trigger every error path; check for stack traces, provider internals, or key material in responses.
- **WSTG-CRYP:** cryptographic testing — verify the JWT paths you test actually reject what they should.

### 2. OWASP MASVS v2.0 / MASTG (mobile)
Apply to `apps/mobile`. Specifically:
- **MASVS-STORAGE:** every file the app writes — what PII/keys/tokens land on disk? Check SQLite, SecureStore, caches, logs.
- **MASVS-CRYPTO:** every use of randomness, every key lifecycle (generation → storage → rotation → deletion).
- **MASVS-AUTH:** session fixation, token refresh races, logout completeness (is the SecureStore wiped? is the Noise session torn down?).
- **MASVS-PLATFORM:** deep link (`bimax://`) fuzzing — what happens with `bimax://evil`, overly long URLs, unexpected paths?
- **MASVS-CODE:** debug code, verbose logging, hardcoded secrets (re-verify — don't assume the prior audit caught all).

### 3. OWASP API Security Top 10 (2023)
Apply to the gateway. The prior audit covered API1, API2, API5, API7, API8, API10 with no findings — **push harder on the ones they cleared**, especially:
- **API4 (Unrestricted Resource Consumption):** beyond BMA-03/07 — are there *other* unbounded operations? SSE stream duration? Concurrent streams per user?
- **API6 (Unrestricted Business Flow):** can the chat flow be abused in ways that cost money but aren't "attacks"? (e.g., rapid model-switching, empty messages, 1-token prompts in a loop)

### 4. OWASP LLM Top 10 (2025)
Apply to the AI gateway and future memory system. Specifically:
- **LLM01 (Prompt Injection):** the gateway currently passes user messages straight through. When the v0.2 memory system injects retrieved context, how will it be delimited? Design the attack *now*: craft a conversation that, when retrieved as "memory," overrides instructions.
- **LLM06 (Excessive Agency):** map every tool/action the system can take; for each, ask "what's the blast radius if the model is tricked into invoking this?"
- **LLM10 (Unbounded Consumption):** beyond token spend — can an attacker cause infinite loops in streaming? Retry storms?

### 5. NIST SP 800-115 — testing methodology
Follow the four phases and document which phase each finding came from:
- **Planning:** threat model first (see STRIDE below) — don't just grep.
- **Discovery:** map every entry point before testing any of them.
- **Attack:** attempt exploitation, not just identification. If you claim a bug, show the malicious input.
- **Reporting:** every finding needs impact + likelihood + fix.

### 6. STRIDE threat modeling
Before diving into code, build a STRIDE model for **each** of these three data flows and hunt specifically for the threats you identify:
1. **Phone → Gateway → Provider** (chat plane): Spoofing (fake gateway?), Tampering (MITM on API calls?), Repudiation (can a user deny usage?), Information disclosure, DoS, Elevation.
2. **Phone → Relay → Desktop** (remote plane): focus on Spoofing (fake desktop/phone) and Elevation (phone → laptop RCE).
3. **Pairing flow** (QR → hello → Noise → verification code): focus on Tampering and Spoofing at each step.

### 7. CWE Top 25 — checklist
Explicitly check for each of these CWEs and state "checked, not found" or file the finding:
CWE-79 (XSS), CWE-89 (SQLi), CWE-20 (input validation), CWE-200 (info exposure), CWE-798 (hardcoded creds), CWE-287 (auth bypass), CWE-352 (CSRF), CWE-434 (unrestricted upload), CWE-862 (missing authz), CWE-863 (incorrect authz), CWE-276 (bad permissions), CWE-306 (missing auth), CWE-307 (brute force), CWE-327 (broken crypto), CWE-330 (weak randomness), CWE-362 (race condition), CWE-400 (resource exhaustion), CWE-416 (use after free — N/A for TS, state it), CWE-476 (null deref), CWE-502 (deserialization), CWE-601 (open redirect), CWE-611 (XXE — N/A, state it), CWE-918 (SSRF).

---

## Scope — read everything

- `apps/mobile/` — all of `lib/`, `app/`, `components/`
- `apps/gateway/src/` — all files
- `apps/desktop-responder/src/` — all files
- `apps/relay/src/`, `apps/cloud-relay/src/` — all files
- `packages/protocol/src/` — protocol definitions
- Configs: `wrangler.toml` (both), `app.json`, `package.json` files

You have device file access. Read the code — do not rely on the prior audits' descriptions.

---

## Attack playbook — specific techniques to attempt

Beyond the frameworks above, **actively attempt** these:

1. **Fuzz the protocol:** craft malformed envelopes — wrong `v`, missing fields, extra fields, `kind` values that don't exist, oversized `id`, negative `ts`. Feed them to the mobile dispatcher and the responder. What crashes? What gets accepted?
2. **State-machine abuse:** pairing, session, and approval flows are state machines. Try every invalid transition: confirm without candidate, approve twice, approve after expiry, handshake message replay, grant replay.
3. **Race the money:** beyond F04/F05/BMA-01/02 — try *cross-endpoint* races (chat + usage simultaneously), rapid connect/disconnect on the relay, KV eventual-consistency exploitation.
4. **Be the malicious relay:** you control the relay. What can you learn? What can you modify without detection? Can you replay old ciphertexts? Can you drop *specific* messages (kill requests?) while forwarding others?
5. **Be the lost phone:** you have the device, it's locked. What's extractable? (BMA-10 covered SQLite — go further: SecureStore dump feasibility, backup files, cached images, clipboard.)
6. **Be the malicious app on the phone:** what IPC/deep-link surfaces can you abuse? Can you trigger actions in Bimax from another app?
7. **Chain them:** the best findings combine two "medium" issues into one "critical." Example pattern: BMA-04 (malicious relay via QR) + F01 (plaintext dispatcher) = attacker-in-the-middle who can *inject* fake approvals, not just observe. Find new chains.
8. **Differential testing:** mobile and desktop both implement Noise, framing, and base64. Feed identical inputs to both — do they behave identically? Any divergence is a bug.
9. **Time-travel:** set device clocks forward/backward. What breaks? (Certificate expiry, `sentAt` windows, quota month boundaries, JWT `exp`.)
10. **Upgrade/downgrade:** install v0.1 data, then run current code. Does the SQLite schema migrate? Do old trust records still work? Are old protocol messages handled?

---

## Rules

1. **No duplicates.** Every finding must be novel vs F01–F15 and BMA-01–28. When in doubt, cite the closest existing finding and explain the difference.
2. **File:line evidence for everything.** No "there might be an issue in the auth module." Exact file, exact line.
3. **Show the malicious input.** For input-validation findings, provide the actual payload that triggers it.
4. **Severity with reasoning.** Use Critical/High/Medium/Low and justify with impact × likelihood. "Critical" means RCE, fund drainage, or full account takeover with realistic prerequisites.
5. **Fix must be concrete.** Not "validate input" — show the validation code or the exact check to add.
6. **State your framework.** Each finding must name which methodology above led to it (e.g., "WSTG-INPV," "STRIDE-Tampering," "CWE-400").
7. **Minimum 10 novel findings.** Fewer is failure — dig deeper.

---

## Output format

```markdown
# AUDIT-2 Findings

## [SEVERITY] Title
**ID:** AUD2-001 (number sequentially)
**Framework:** (e.g., WSTG-INPV / MASVS-STORAGE / STRIDE-Spoofing / CWE-400)
**File:** path/to/file.ts:LINE
**Novelty:** not covered by F__/BMA-__ because ___ (one sentence)
**Attack scenario:** (who, prerequisites, step-by-step)
**Malicious input / PoC:** (actual payload or reasoning)
**Impact:** (what the attacker gains, INR cost if spend-related)
**Fix:** (concrete code or config change)
```

Then a summary table: ID | Severity | Title | File | Framework.

---

## Acceptance

1. Minimum 10 novel findings, each with file:line evidence and a named framework.
2. Zero duplicates of F01–F15 / BMA-01–28 (each finding carries a novelty justification).
3. At least one finding from each of: gateway, mobile, responder/relay.
4. At least 3 findings discovered via active attack attempts (fuzzing, state-machine abuse, chaining) — not just code reading.
5. CWE Top 25 checklist completed (each item marked checked-not-found or filed).

Return the full report. Do not fix anything — findings only.
