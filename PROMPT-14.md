# Bimax Mobile — Prompt #14: implement the desktop responder

Copy everything below the line into Antigravity as one prompt.

---

Background: `DESKTOP-RESPONDER-CONTRACT.md` (repo root) is the finalized spec for
the desktop side of the phone↔laptop system. It has been reviewed and corrected.
This prompt implements it: `apps/desktop-responder/` — engine-agnostic, talking
to the Bimax engine ONLY through the `EnginePort` interface, with a deterministic
`FakeEngine` for tests. The real engine (`~/Bimax`) is NOT touched in this prompt.

**Read `DESKTOP-RESPONDER-CONTRACT.md` in full before writing any code. It is the
spec. Where this prompt and the contract disagree, the CONTRACT wins — flag the
discrepancy in your return.**

## 0. Protocol v1.7 (additive) — `packages/protocol/src/index.ts`

Add the changelog entry and these exact additions (no `PROTOCOL_VERSION` bump —
same additive convention as v1.1–v1.6):

```ts
// MessageKind gains:
  | "chat_message"
  | "chat_token"
  | "chat_done"
  | "file_offer"
  | "file_accept"
  | "file_reject"
  | "file_chunk"
  | "file_done"
  | "file_received"
  | "file_error"

export interface ChatMessage {
  idempotencyKey: string; // non-empty, ≤128 chars
  sessionId?: string;
  text: string;           // ≤32 KB; empty text with no fileIds is rejected
  fileIds?: string[];
  sentAt: number;
}
export interface ChatToken { idempotencyKey: string; seq: number; token: string; }
export interface ChatDone {
  idempotencyKey: string; sessionId: string;
  ok: boolean; error?: string; at: number;
}
export interface FileOffer {
  transferId: string;     // 128-bit random hex, client-generated
  name: string;           // ≤255 chars
  mime: string;           // allowlist: application/pdf, image/*, text/*, application/octet-stream
  sizeBytes: number;      // ≤ 25 MB
  sha256: string;         // hex SHA-256 of the complete file
}
export interface FileAccept { transferId: string; }
export interface FileReject { transferId: string; reason: string; }
export interface FileChunk { transferId: string; seq: number; data: string; }
  // data: base64, decodes to ≤ 64 KB plaintext per chunk
export interface FileDone { transferId: string; }
export interface FileReceived { transferId: string; fileId: string; }
export interface FileError { transferId: string; code: string; message: string; }
```

## 1. Package layout — `apps/desktop-responder/`

```
apps/desktop-responder/
  package.json   — private, deps: ws, @noble/curves, @noble/hashes.
                   devDeps: typescript, @types/ws, @types/node. No new ROOT deps.
  tsconfig.json  — strict: true, noUncheckedIndexedAccess: true, no `as any`, no Buffer.
  src/
    engine-port.ts   — the EXACT interface from contract §14 (copy it verbatim).
    identity.ts      — first-run generation + persistence of deviceId (random
                       128-bit hex), X25519 static keypair (Noise), Ed25519
                       keypair (hello signing). File-based store for dev/test
                       (OS keychain wiring is the later ~/Bimax adapter's job;
                       note this in a comment).
    relay-client.ts  — outbound wss client to /room/<desktopDeviceId> (cloud or
                       LAN URL). MUST send SIGNED hellos, constructed EXACTLY
                       like the phone's (PROMPT-10): sign(utf8(canonicalJson({
                       id, ts, from, deviceId, role: "desktop", helloPubkey })))
                       with the envelope's own id/ts/from. Exponential-backoff
                       reconnect (1s → 30s max, jitter), re-hello every time.
    pairing.ts       — Noise IK responder (NoiseIKResponder from the copied
                       noise.ts): readMessage1 → writeMessage2 → pairing_grant.
                       QR ref rotation (20s) + 60s expiry, single-use refs.
                       Trusted-phone store (ONE record, V1 — re-pairing replaces
                       only after explicit confirmation, expose
                       confirmReplaceTrustedPhone()). Verification codes via
                       formatVerificationCode(handshakeHash) from the copied
                       session.ts. Re-handshake path when the phone's X25519 key
                       equals the pinned key (skip ref validation). Incoming
                       pairing_revoke → delete record, teardown sessions, clear
                       idempotency entries.
    e2e.ts           — thin wrapper over the copied framing.ts seal/open, plus
                       per-peer E2EState registry with the contract §5 rule:
                       newE2EState() on EVERY newly established Noise session.
    approvals.ts     — the §7 verification gate, EXACT 5-step order from the
                       contract (pending check → recompute requestHash over the
                       STORED sent object with constant-time compare → Ed25519
                       verify against the PINNED phoneHelloPubkeyB64 → skew/ID
                       checks → single-use consume → resolveApproval).
                       not_me → security event. 30s expiry sweep → auto-deny.
    idempotency.ts   — IdempotencyLog per contract §8: key → { status:
                       "in-flight" | "done", result, at }, checked BEFORE any
                       EnginePort call; 24h TTL + 10,000-entry LRU cap;
                       persisted across restarts (JSON file is fine).
    files.ts         — §10 receive pipeline: offer validation (caps, mime,
                       transferId shape) → accept/reject → strict-sequenced
                       chunks (seq must equal expected-next) → SHA-256 verify
                       on file_done → store as <inboxDir>/<responder-generated
                       fileId> with sidecar metadata (original name kept OUT of
                       the path) → file_received / file_error. 10-min offer
                       expiry. Inbox dir OUTSIDE engine working dirs.
    chat.ts          — §9: chat_message → EnginePort.chat with onToken →
                       seq-ordered chat_token frames → chat_done. 1 MB token
                       buffer cap per message; approvals may arrive mid-turn
                       (turn suspends until resolveApproval).
    responder.ts     — the dispatcher: relay socket → hello → Noise sessions →
                       E2E open → innerKind switch → handler → EnginePort.
                       Unknown inner kinds ignored (counted). Malformed frames
                       ignored. Crypto failures → session teardown + security
                       event. Emits the JSONL security log (§13).
    fake-engine.ts   — deterministic FakeEngine per contract §15: scripted
                       chat token streams, programmable approval emissions,
                       controllable task durations, execution counters,
                       injectable clock.
    index.ts         — wiring: load identity → connect relay → start responder.
                       No engine import here (the port is injected).
```

Shared code — COPY unchanged from this repo (one-way rule: fix upstream, re-copy):
`apps/mobile/lib/crypto/noise.ts`, `apps/mobile/lib/crypto/keys.ts`,
`apps/mobile/lib/crypto/base64.ts`, `apps/mobile/lib/e2e/framing.ts`,
`apps/mobile/lib/session/session.ts` (for `formatVerificationCode` and
`NoiseIKResponder`/`PairingManager` types only — do NOT import the provider).
Protocol types come from `@bimax/protocol` (check how other packages reference
it and do the same).

## 2. Integration tests — `apps/desktop-responder/test/integration-test.mjs`

Plain Node, same tmpdir-compile pattern as the other test suites. The harness
spins up THREE real things: (1) a real relay — build and spawn `apps/relay`
like `relay-smoke.mjs` does; (2) a real `Responder` (compiled from
`apps/desktop-responder/src`) wired to `FakeEngine`; (3) the REAL phone stack —
`RelayClient` from `apps/mobile/lib/relay/client.ts`, `PairingManager` from
`apps/mobile/lib/session/session.ts`, `seal`/`open`/`newE2EState` from
`apps/mobile/lib/e2e/framing.ts`, `buildApprovalDecision`/`signApprovalDecision`
from `apps/mobile/lib/approvals/approvals.ts` (follow `relay-smoke.mjs` for
instantiating RelayClient in Node). Real `ws` sockets, real Noise IK, real
X25519/Ed25519. NO mocked crypto or transport. The test phone stack manages its
own E2EState and resets it on every new Noise session (contract §5; the
phone-app FIX comes later).

All nine contract §16 cases, in order:
1. **Pairing**: QR advert → pairing_request → pairing_grant → verification codes
   match on both sides → trusted-phone record written.
2. **Re-handshake + E2E reset**: new Noise session for the trusted phone; both
   sides reset E2E state; a frame sealed under the OLD session is rejected; new
   frames flow.
3. **In-session replay**: duplicated encrypted frame (same outer id) dropped; a
   frame with an old seq rejected.
4. **Chat**: chat_message → ordered chat_tokens → chat_done; sessionId
   continuity across turns.
5. **Approval v1.6**: FakeEngine emits approval → phone approves →
   resolveApproval("approved") observed on FakeEngine. Attack cases: a decision
   with requestHash for DIFFERENT content (validly signed) → rejected, engine
   never told; a decision with a bad signature → rejected.
6. **Idempotency**: command_request with key K → drop the socket mid-flight →
   reconnect → re-send K → FakeEngine execution counter stays 1, phone gets the
   stored result.
7. **Kill**: long task on FakeEngine → kill_request → kill_result {ok:true} →
   FakeEngine confirms cancellation → pending approval for that session
   auto-denied.
8. **File transfer**: 1 MB PDF offer → chunks → file_received with verified
   SHA-256; oversized offer rejected; "../../evil" name stored safely under
   fileId; corrupted final bytes → file_error and FakeEngine never sees it.
9. **Recovery**: task in-flight → socket dropped → reconnect + re-handshake →
   re-request by key → stored result, execution counter unchanged.

Print PASS/FAIL per case, tear everything down, exit 0 iff all nine pass.

## SCOPE — DO NOT DO

- Do NOT touch `~/Bimax` (the real engine) — the adapter is a later prompt.
- Do NOT change the phone app (`apps/mobile`) — the E2E-reset FIX is a later,
  separate prompt.
- Do NOT change `apps/relay`, `apps/cloud-relay`, or `packages/protocol`
  beyond the v1.7 additions in §0. No `PROTOCOL_VERSION` bump.
- No new root dependencies. No `as any`, no Buffer. No UI.

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/desktop-responder && npm install` → exit 0
2. `cd apps/desktop-responder && npx tsc --noEmit` → zero errors
3. `npx eslint apps/desktop-responder` (from repo root) → zero errors
4. `node apps/desktop-responder/test/integration-test.mjs` → all nine cases PASS
5. Regression: `node apps/mobile/test/approvals-test.mjs` → all six steps PASS
   (v1.7 didn't break v1.6)
6. `grep -n "chat_message" packages/protocol/src/index.ts` → hits

## RETURN FOR REVIEW (paste all four)

1. The file tree of `apps/desktop-responder`
2. `src/engine-port.ts`, `src/idempotency.ts`, and `src/approvals.ts` IN FULL
   (the security core — these get the closest review)
3. The FULL terminal output of acceptance commands 1–6
4. Explicit confirmation of each SCOPE item (~/Bimax untouched, phone
   untouched, no other packages changed beyond the v1.7 addition)
