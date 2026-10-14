# Bimax Mobile — Desktop Responder Contract v1

Status: SPEC (not code). The responder is implemented against this document in a later
prompt. The real Bimax engine (`~/Bimax`) MUST NOT be touched until this contract and
the responder's integration tests are complete.

Parties: **Responder** (`apps/desktop-responder/`, this repo) — owns transport, Noise,
pairing, E2E framing, protocol handlers, and the `EnginePort` interface. **Engine**
(the Bimax desktop engine) — reached ONLY through `EnginePort`; a **FakeEngine**
serves for deterministic tests. **Phone** — the existing mobile app, protocol v1.6.

V1 supports exactly ONE trusted phone per desktop (re-pairing replaces the record
with explicit on-desktop confirmation). Multi-phone/multi-desktop is V3.

---

## 1. Layout

```
apps/desktop-responder/
  package.json            — deps: ws, @noble/curves, @noble/hashes. No new root deps.
  tsconfig.json           — strict, no `as any`, no Buffer.
  src/
    index.ts              — entry: load identity, connect relay, start pairing UI hooks
    identity.ts           — deviceId + X25519 (Noise) + Ed25519 (hello) keys, persisted
                            via OS-safe storage (Electron safeStorage in prod;
                            file fallback in dev/test)
    relay-client.ts       — outbound wss client (may reuse the mobile RelayClient
                            design; must send SIGNED hellos, same construction as phone)
    pairing.ts            — Noise IK responder, QR/ref rotation, trusted-phone store,
                            verification codes
    e2e.ts                — SealedFrame seal/open per §4
    approvals.ts          — v1.6 verification gate per §6
    idempotency.ts        — replay-resistant execution log per §7
    files.ts              — secure receive pipeline per §10
    chat.ts               — chat session handling per §9
    responder.ts          — protocol dispatcher: encrypted frame → handler → EnginePort
    engine-port.ts        — the EnginePort interface (§14) + event types
    fake-engine.ts        — deterministic FakeEngine for tests (§15)
  test/
    integration-test.mjs  — real sockets + real Noise, per §16
```

Shared code (copied, same one-way rule as the relay backport — fix upstream first,
then re-copy): `apps/mobile/lib/crypto/{noise,keys,base64}.ts`,
`apps/mobile/lib/e2e/framing.ts`. Protocol types from `packages/protocol`.

---

## 2. Identity and keys

- On first run the responder generates: `deviceId` (random 128-bit hex), an X25519
  static keypair (Noise), and an Ed25519 keypair (hello signing). All persisted.
- The Ed25519 pubkey is the desktop's long-term identity. The relay TOFU-pins it;
  the phone TOFU-pins it at pairing (existing mobile behavior).

## 3. Transport

- Outbound `wss://` to the relay room `/room/<desktopDeviceId>` (cloud or LAN URL —
  same room scheme as Prompt #12).
- First message is a SIGNED hello, constructed EXACTLY like the phone's (PROMPT-10):
  `sign(utf8(canonicalJson({ id, ts, from, deviceId, role: "desktop", helloPubkey })))`
  with the envelope's own id/ts/from. Unsigned hellos are rejected by both relays —
  the responder must never send one.
- Reconnect with exponential backoff (1s → 30s max, jitter). Every reconnect
  re-hellos. Application state lives above the transport (§12).

## 4. Pairing

- QR encodes `PairingAdvertisement`: `{ relayUrl, lanRelayUrl, ref, desktopDeviceId,
  desktopPublicKey (base64 X25519), app: "bimax" }`.
- `ref` rotates every 20s and expires after 60s. A `pairing_request` carrying an
  unknown/expired ref is rejected silently (no grant, no error frame).
- Noise IK: the phone is initiator. The responder feeds `handshakeMessage` (msg 1)
  into `NoiseIKResponder.readMessage1`, then answers with `writeMessage2` inside
  `pairing_grant`.
- The responder distinguishes two pairing paths by the phone's X25519 static key:
  - **Re-handshake**: the key equals the trusted phone's pinned X25519 key →
    skip ref validation, complete the handshake, replace the live session, reset
    E2E state (§5). (The phone reuses its long-lived static keypair across
    pairings and re-handshakes — key reuse across ceremonies is EXPECTED; the
    Noise handshake's ephemerals provide per-ceremony freshness.)
  - **Fresh pairing**: the key is new → the `pairing_request.ref` MUST be a live
    (unexpired, unconsumed) ref from the current rotation; each ref is
    single-use.
  - Any other case (unknown key + bad/missing ref) → silent reject.
- Verification code: `formatVerificationCode(handshakeHash)` from
  `apps/mobile/lib/session/session.ts` (deterministic,
  format `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`; both sides derive it from the Noise
  handshake hash, exactly as `apps/mobile/test/pairing-test.mjs` STEP 5 does).
  The desktop shows it; the user compares with the phone. Trust is established
  ONLY after this human confirmation — mirroring the phone-side rule from
  FIX-3c.
- Trusted-phone store (one record, V1): `{ phoneDeviceId, phoneX25519PubkeyB64,
  phoneHelloPubkeyB64, pairedAt }`, persisted encrypted. Re-pairing REPLACES the
  record only after explicit on-desktop confirmation.
- Known-device re-handshake: a `pairing_request` from the trusted phone's X25519
  key starts a NEW Noise session (same static keys). On success: replace the live
  session, RESET E2E state (§5), keep the trust record.
- `pairing_revoke`: the desktop can revoke; the record is deleted and all sessions
  for that phone are torn down. If the PHONE sends `pairing_revoke`, the
  responder likewise deletes the trust record, tears down all sessions for that
  phone, and clears its idempotency entries. (Phone-side revoke UI is a later
  prompt; responder-side handling of both directions is required now.)

## 5. E2E framing contract

- Every application message travels as `kind: "encrypted"` with
  `EncryptedPayload{ ciphertext }` = base64(Noise-transport-encrypt(
  UTF-8(canonicalJson(SealedFrame)) )).
- `SealedFrame` is EXACTLY `apps/mobile/lib/e2e/framing.ts`:
  `{ fver: 1, innerKind (never "encrypted"), seq, body, bound: { id, from, to } }`.
  `bound` MUST equal the outer envelope's `id`/`from`/`to`, else the frame is
  rejected. `seq` is the sender's per-peer monotonic counter starting at 0.
- **Sequence rule (DECIDED): both peers MUST reset E2E state (`newE2EState()`)
  on every newly established Noise transport session.** Fresh session keys ⇒
  fresh replay space. Rationale: the Noise handshake authenticates new keys; the
  app-level seq is replay protection WITHIN a key epoch, not across them.
  - Within a session: `open()` rejects any frame with `seq <= recvHighestSeq`
    (replay) and any duplicate outer `id` (seen-set, 2000 cap).
  - Consequence: the PHONE needs a small follow-up fix (it currently persists
    E2E state across re-handshakes). That FIX prompt comes after the responder
    is implemented. Until then, phone↔responder integration tests use the
    responder-side rule with a test phone stack that also resets.
- Max decrypted inner message: 256 KB (matches the relay cap).

## 6. Authorization boundaries

1. **Transport**: only signed-hello + TOFU-pinned devices reach the relay room.
2. **Trust**: an E2E session exists only for the ONE trusted phone. Frames from
   any other Noise peer are impossible by construction (the responder only
   completes handshakes for the trusted phone's X25519 key, or during the
   human-confirmed pairing flow).
3. **Attribution**: every decrypted frame is attributed to the `phoneDeviceId`
   of its Noise session. The responder keeps a `session → phoneDeviceId` map and
   stamps it on every handler call.
4. **Capability allowlist**: the responder exposes EXACTLY the `EnginePort`
   surface (§14). No shell, no filesystem passthrough, no engine internals.
   Unknown inner kinds are ignored (counted, not executed).
5. **No self-execution**: the responder NEVER interprets instructions itself. It
   translates protocol → `EnginePort` calls. Tool policy (risk tiers, sandboxing)
   lives in the engine.
6. **Deny by default**: malformed frames → ignored; crypto failures → session
   teardown + security event (§13).

## 7. Approval flow — v1.6 verification gate

The engine emits `ToolApprovalRequest`s (via `EnginePort.onApprovalRequest`).
The responder sends `approval_request` over E2E and tracks
`approvalId → { request, expiresAt, consumed }`.

On receiving `approval_decision`, verify IN THIS ORDER (fail = ignore + security
event; the engine is NEVER told):
1. `approvalId` matches a pending, unexpired, unconsumed request; else ignore.
2. Recompute `requestHash` = base64(SHA-256(UTF-8(
   canonicalJson(STORED request object — the exact bytes sent to the phone))));
   compare with `decision.requestHash` using a constant-time compare; mismatch ⇒
   reject ("request content changed after display"). The responder MUST hash the
   exact object it serialized when sending the `approval_request` (store it at
   send time) — hashing a reconstructed object risks field drift and false
   rejections.
3. Verify the Ed25519 signature over `canonicalJson(decision minus "signature")`
   against the PINNED `phoneHelloPubkeyB64` from the trusted-phone record —
   NEVER a key carried in the message. Failure ⇒ reject.
4. `decision.approvalId`/`sessionId` equal the stored request's; `|now -
   decidedAt| <= 300_000`; else reject.
5. Mark consumed (decisions are SINGLE-USE; a duplicate delivery is ignored, not
   re-applied), then call `enginePort.resolveApproval(approvalId, decision,
   denyReason)`.

The responder is the verification gate: the engine must treat
`resolveApproval` as authoritative and must not re-verify (single gate, no
split-brain).

- `denyReason: "not_me"` additionally raises a SECURITY event (§13) — it means
  either the wrong human approved or the phone is compromised.
- Liveness: a sweep every 30s auto-resolves EXPIRED approvals as denied to the
  engine, so a tool call can never hang forever waiting for a phone that went
  away.

## 8. Replay-resistant command execution (idempotency)

- Every `command_request`, `kill_request`, and `chat_message` carries a
  client-generated `idempotencyKey` (non-empty, ≤128 chars; else rejected).
- `IdempotencyLog`: `key → { status: "in-flight" | "done", result, at }`,
  checked BEFORE any `EnginePort` call:
  - `done` → return the stored result immediately, no re-execution.
  - `in-flight` → attach to the running task; the requester gets its eventual
    result (no second execution).
  - miss → execute, store the result on completion.
- **This is what makes reconnects safe**: the phone's transport may redeliver
  after a drop/re-handshake. Redelivery with the same key NEVER re-executes.
- Retention: 24h TTL + 10,000-entry cap (LRU eviction). Persisted across
  responder restarts (SQLite or JSON file — implementation choice, must survive
  restart to keep the guarantee).
- `command_result` / `kill_result` / `chat_done` echo the `idempotencyKey`.

## 9. Chat mode

Protocol v1.7 (additive) kinds:
```ts
export interface ChatMessage {
  idempotencyKey: string; sessionId?: string; text: string;
  fileIds?: string[]; sentAt: number;
}
export interface ChatToken { idempotencyKey: string; seq: number; token: string; }
export interface ChatDone {
  idempotencyKey: string; sessionId: string;
  ok: boolean; error?: string; at: number;
}
```
- `chat_message` → `EnginePort.chat(input, onToken)`; each token → `chat_token`
  (seq-ordered); completion → `chat_done`. `onToken` backpressure: buffer
  (cap 1 MB per message) and drop the stream on disconnect — the full result
  remains available via re-request under the same idempotencyKey (§8).
- A chat turn MAY trigger tool approvals: the engine emits `approval_request`
  mid-turn; the turn suspends until `resolveApproval`; then continues. This is
  the "chat that can ACT" — chat and approvals share the session.
- `text` max 32 KB; empty text with no fileIds → rejected.

## 10. Secure file transfer (phone → desktop, V1)

Protocol v1.7 (additive) kinds:
```ts
export interface FileOffer {
  transferId: string; name: string; mime: string;
  sizeBytes: number; sha256: string; // hex SHA-256 of the complete file
}
export interface FileAccept { transferId: string; }
export interface FileReject { transferId: string; reason: string; }
export interface FileChunk { transferId: string; seq: number; data: string; }
  // data: base64, decodes to ≤ 64 KB plaintext per chunk
export interface FileDone { transferId: string; }
export interface FileReceived { transferId: string; fileId: string; }
export interface FileError { transferId: string; code: string; message: string; }
```
Rules (all enforced before the engine ever sees the file):
1. `transferId`: 128-bit random hex, client-generated; unknown/expired → chunks
   rejected. Offer expires after 10 min or on superseding offer.
2. Caps: `sizeBytes ≤ 25 MB` per transfer; chunk plaintext ≤ 64 KB; name ≤ 255
   chars; mime from an allowlist (`application/pdf`, `image/*`, `text/*`,
   plus `application/octet-stream` as generic).
3. Flow: `file_offer` → responder validates caps → `file_accept` (or
   `file_reject` with reason). Chunks accepted ONLY for accepted transfers,
   with `seq` EXACTLY equal to expected-next (strict order; gap/duplicate ⇒
   `file_error` + transfer aborted).
4. On `file_done`: SHA-256 over reassembled bytes MUST equal `offer.sha256`;
   else `file_error` and the bytes are discarded.
5. Storage: `<inboxDir>/<fileId>` where `fileId` is responder-generated
   (never the client name). Original name kept in sidecar metadata ONLY.
   No path traversal is possible by construction. The inbox dir is OUTSIDE the
   engine's working directories; the engine receives the file via
   `EnginePort.attachFile({ fileId, ... })` when the phone references it in a
   chat/command (`fileIds`).
6. Desktop → phone transfer is NOT in V1 (extension point noted; same
   construction mirrored).

## 11. Cancellation propagation

- `kill_request{ idempotencyKey, reason? }` → `EnginePort.kill(...)` →
  `kill_result{ idempotencyKey, ok, detail?, at }`. Kill is idempotent (§8).
- Engine semantics required of the port: abort the running task/session;
  if a tool is mid-flight and cannot be aborted, the engine MUST stop
  scheduling further steps and report `ok: true, detail: "stopped after
  current step"`. A kill that finds nothing running returns `ok: true,
  detail: "nothing running"`.
- Any approval pending for a killed session is auto-resolved as denied
  (the responder emits the denial to the engine; the phone gets no decision
  to make).

## 12. Task recovery after disconnection

- The responder keeps `in-flight: idempotencyKey → { kind, startedAt,
  phoneDeviceId }`. Engine tasks are NOT cancelled on transport drop — the
  laptop is the durable side; results land in the idempotency log (§8).
- On phone reconnect + re-handshake: the phone re-queries status/session list
  (fresh state, never assumed). For any key it never got a result for, it
  re-sends the request → the responder returns the STORED result (or attaches
  to the still-running task). Duplicate execution is impossible by §8.
- The relay's outbox (7-day TTL) covers messages sent while the phone was
  offline; `delivery_ack` semantics unchanged.

## 13. Error handling and security events

- Taxonomy: transport (reconnect w/ backoff) · crypto (teardown session +
  security event) · protocol (ignore + counter) · engine (map to
  `command_result{ok:false}` / `chat_done{ok:false,error}` /
  `kill_result{ok:false}`).
- Error frames carry `{ code, message }` with SAFE messages only — never engine
  internals, stack traces, paths, or keys.
- Security events (bad approval signature/hash, device-key change, replayed
  frame, id-validation failure) append to a local append-only security log
  (JSONL). This is the seed of the V3 audit ledger; V1 only needs the file.

## 14. EnginePort (exact interface)

```ts
import type {
  AgentStatus, AgentSessionInfo, CommandResult, KillResult,
  ToolApprovalRequest,
} from "@bimax/protocol";

export type ApprovalVerdict = "approved" | "denied";

export interface EnginePort {
  /** Current agent state for the status card. */
  getStatus(): Promise<AgentStatus>;
  /** Sessions the phone may display/switch between. */
  listSessions(): Promise<AgentSessionInfo[]>;
  /** Fire-and-forget instruction; idempotent via idempotencyKey (§8). */
  sendInstruction(input: {
    idempotencyKey: string; instruction: string;
  }): Promise<CommandResult>;
  /** Conversational turn; streams tokens via onToken (§9). */
  chat(
    input: {
      idempotencyKey: string; sessionId?: string;
      text: string; fileIds?: string[];
    },
    onToken: (token: string) => void,
  ): Promise<{ sessionId: string }>;
  /** Cancel the running task (§11). */
  kill(input: { idempotencyKey: string; reason?: string }): Promise<KillResult>;
  /** Register a verified-received file for later reference (§10). */
  attachFile(input: {
    fileId: string; name: string; mime: string; sizeBytes: number;
  }): Promise<void>;
  /** Engine → responder: a tool needs user approval (§7). */
  onApprovalRequest(cb: (req: ToolApprovalRequest) => void): void;
  /** Engine → responder: status changed (proactive push). */
  onStatusChanged(cb: (status: AgentStatus) => void): void;
  /** Responder → engine: deliver a VERIFIED approval decision. */
  resolveApproval(
    approvalId: string,
    verdict: ApprovalVerdict,
    denyReason?: "not_me" | "mistake",
  ): void;
}
```

Notes for the future adapter author: `resolveApproval` is authoritative — the
engine must suspend the tool call until it arrives (or approval expiry).
`onApprovalRequest` must fire BEFORE the tool executes. Risk tiers/diff
summaries are engine-side (V3); the port carries the request as-is.

## 15. FakeEngine (deterministic, for tests)

- Implements `EnginePort` with scripted behavior: canned chat responses
  (token stream), programmable approval emissions, controllable task durations
  (for kill tests), execution counters (for idempotency assertions).
- Deterministic: no randomness, no clocks in assertions (injectable `now`).

## 16. Integration tests (REAL sockets, REAL Noise — no mocked crypto/transport)

The test harness spins up: a real relay (`apps/relay`, built), a real
`Responder` wired to `FakeEngine`, and the REAL phone stack
(`RelayClient` + `PairingManager` + `seal`/`open` from `apps/mobile/lib`).
`ws` sockets, real Noise IK handshakes, real X25519/Ed25519. Required cases:

1. **Pairing**: QR advert → `pairing_request` → `pairing_grant` → verification
   codes match on both sides → trusted-phone record written.
2. **Re-handshake + E2E reset**: new Noise session for the trusted phone;
   both sides reset E2E state; a frame sealed under the OLD session is
   rejected; new frames flow.
3. **In-session replay**: a duplicated encrypted frame (same outer id) is
   dropped; a frame with an old seq is rejected.
4. **Chat**: `chat_message` → ordered `chat_token`s → `chat_done`; sessionId
   continuity across turns.
5. **Approval v1.6**: FakeEngine emits an approval → phone approves →
   `resolveApproval("approved")` observed. Attack cases: decision with a
   `requestHash` for DIFFERENT content (validly signed) → rejected, engine
   never told; decision with a bad signature → rejected.
6. **Idempotency**: send `command_request` with key K; drop the socket
   mid-flight; reconnect; re-send K → engine executed ONCE (counter = 1),
   phone gets the stored result.
7. **Kill**: start a long task on FakeEngine; `kill_request` → `kill_result
   {ok:true}`; FakeEngine confirms cancellation; pending approval for that
   session auto-denied.
8. **File transfer**: offer 1 MB PDF → chunks → `file_received` with verified
   SHA-256; oversized offer rejected; `../../evil` name stored safely by
   fileId; corrupted final bytes → `file_error`, engine never sees it.
9. **Recovery**: task in-flight, socket dropped, reconnect + re-handshake,
   re-request by key → stored result, no duplicate execution.

## 17. Protocol additions (v1.7, additive)

`packages/protocol/src/index.ts`: `MessageKind` gains `"chat_message" |
"chat_token" | "chat_done" | "file_offer" | "file_accept" | "file_reject" |
"file_chunk" | "file_done" | "file_received" | "file_error"`, plus the
interfaces from §9–§10. Changelog entry. No `PROTOCOL_VERSION` bump
(same additive convention as v1.1–v1.6).

## 18. Phasing (locked)

- Phase 0 — this contract (now).
- Phase 1 — implement `apps/desktop-responder/` + `FakeEngine` + integration
  tests against this contract (next prompt).
- Phase 2 — phone FIX: reset E2E state on new Noise transport session
  (small, after Phase 1).
- Phase 3 — thin production adapter in `~/Bimax` mapping the real engine to
  `EnginePort` (later prompt; `~/Bimax` untouched until then).
- Phase 4 — phone chat UI (later prompt).
