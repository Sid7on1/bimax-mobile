# Bimax — Full Architecture Plan v1

Date: 2026-10-13. Status: LIVING DOCUMENT — update as components land.
This is the master reference: product vision, everything built, everything
planned, and how it all connects.

---

## 1. Product vision

**Bimax is a full AI app like ChatGPT** — desktop app + phone app, both
first-class clients of the same model provider. **Laptop remote control is a
feature that makes the ecosystem, not the product itself.**

- The phone app is a full Bimax client that ALSO has remote control.
- The desktop app is a full Bimax client that CAN BE remote-controlled.
- Positioning: "chat that can ACT" — not a chat clone. The edge is agency:
  it operates your laptop and asks approvals, with E2E encryption throughout.

## 2. Business model

- Subscriber installs the app, pays **₹200/month**.
- Roughly **₹100** of that funds their model usage through Bimax's provider
  account. The rest is margin + infra.
- **One AI gateway** holds the provider API keys and meters per-user usage
  across desktop + phone. No key ever lives on a device.
- Launch models: **DeepSeek + Qwen** (cheap enough for the math to work).
- The gateway is the billing enforcement point: per-user quotas / fair-use
  caps so heavy users can't blow past the ~₹100 budget. Run out → wait for
  next cycle or top up.
- Both apps use the **same provider and models** — one subscription, one
  brain per surface.

## 3. Design principles

1. **Thin phone, thick laptop.** The phone never holds keys, never runs
   models, never executes tools. It is a window: chat UI + approvals + remote.
2. **Local-first.** Files, tools, and agent execution live on the user's
   laptop. Relays see only ciphertext. Nothing of the user's content touches
   Bimax servers except through the gateway (metered model calls).
3. **Approvals for action.** Anything with consequences asks the human first —
   biometric-gated, request-bound (v1.6), E2E-delivered.
4. **Reconnect-safe.** Idempotency everywhere: redelivery never re-executes.
5. **One provider.** Desktop and phone drink from the same well (the gateway).

## 4. System overview

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│        PHONE APP            │         │        DESKTOP APP           │
│   (Expo RN: Android+iOS)    │         │  (Electron; ~/Bimax engine)  │
│                             │         │                              │
│  ┌───────────────────────┐  │         │  ┌────────────────────────┐  │
│  │ Standalone chat UI    │──┼──┐      │  │ Bimax agent (harness)  │  │
│  │ (ChatGPT-like)        │  │  │      │  │ coding + computer use  │  │
│  └───────────────────────┘  │  │      │  └────────────────────────┘  │
│  ┌───────────────────────┐  │  │      │  ┌────────────────────────┐  │
│  │ Remote control UI     │──┼──│──┐   │  │ Desktop responder      │──┼──┐
│  │ sessions/status/kill/ │  │  │  │   │  │ (apps/desktop-responder│  │  │
│  │ approvals/files       │  │  │  │   │  │  via EnginePort)       │  │  │
│  └───────────────────────┘  │  │  │   │  └────────────────────────┘  │  │
└─────────────────────────────┘  │  │   └──────────────────────────────┘  │
         │                       │  │                │                    │
         │ HTTPS/SSE             │  │  wss           │ stdout/tools       │
         ▼                       │  │                ▼                    │
┌─────────────────────────────┐  │  │   ┌──────────────────────────────┐  │
│        AI GATEWAY           │◄─┘  │   │  LOCAL MCP SERVERS / TOOLS   │  │
│  (Cloudflare Worker)        │     │   │  (filesystem, shell, etc.)   │  │
│  keys · metering · quotas   │     │   └──────────────────────────────┘  │
│  standalone chat + MCP      │     │                                     │
└─────────────┬───────────────┘     │   ┌──────────────────────────────┐  │
              │                     └───│            RELAY             │◄─┘
              │ model API               │  LAN (apps/relay) or Cloud   │
              ▼                         │  (apps/cloud-relay)          │
┌─────────────────────────────┐         │  opaque E2E ciphertext only │
│      MODEL PROVIDER         │         └──────────────────────────────┘
│   (DeepSeek + Qwen launch) │
└─────────────────────────────┘
```

Three planes:
- **Chat plane** (always available): phone/desktop → gateway → provider.
- **Remote plane** (laptop awake): phone → relay → responder → engine.
- **Trust plane**: E2E (Noise + SealedFrame) over the remote plane; gateway
  auth (Supabase, V2) over the chat plane.

## 5. What is built (inventory, 2026-10-13)

### packages/protocol — v1.7
Shared TypeScript types both sides compile against. `PROTOCOL_VERSION = 1`
(additive v1.1–v1.7, never bumped). Covers: `Envelope`, `MessageKind`
(pairing, hello, encrypted, approval_*, command_*, kill_*, session_*,
agent_status, chat_*, file_*), `PairingAdvertisement`, `DeviceHello`
(Ed25519-signed), `ToolApprovalRequest` + `ApprovalDecision` with v1.6
`requestHash` binding, `ChatMessage/Token/Done`, `FileOffer/Accept/Reject/
Chunk/Done/Received/Error`.

### apps/mobile — Expo React Native (Android + iOS, one codebase)
- `lib/crypto/`: Noise IK (`noise.ts`), X25519/Ed25519 (`keys.ts`),
  base64, canonical JSON.
- `lib/e2e/framing.ts`: `SealedFrame` seal/open — per-peer monotonic seq,
  bound-header check, 2000-id seen-set, replay rejection.
- `lib/session/`: `PairingManager` (Noise IK initiator, QR ref, verification
  codes), `provider.tsx` (connection state, E2E registry, approval store).
- `lib/approvals/`: v1.6 `buildApprovalDecision`/`signApprovalDecision`,
  biometric gate, async decision propagation.
- `lib/relay/client.ts`: outbound wss client, signed hellos, TOFU.
- UI: QR pairing screen, approval cards (approve/deny + not_me/mistake),
  session list, status card, kill button, instruction sender.
- Tests: `pairing-test.mjs` (5 steps), `approvals-test.mjs` (6 steps),
  `relay-smoke.mjs`. All green.

### apps/relay — LAN relay (Node + ws + SQLite)
Outbound-only wss rooms `/room/<deviceId>`; signed-hello required; TOFU
pinning; bounded/expiring outbox (7-day TTL); `delivery_ack` ownership;
256 KB frame cap; rate limiting; idle reaping. For same-WiFi use.

### apps/cloud-relay — Internet relay (Cloudflare Workers + Durable Objects)
Same protocol as LAN relay: signed hello (120s freshness), Ed25519 verify,
TOFU, per-room Durable Objects, hibernating WebSockets, DO SQLite outbox,
sender binding, ack ownership, 256 KB cap, rate limits, idle reaping.
Both devices dial OUTBOUND — no inbound ports, no tunnels.

### apps/desktop-responder — desktop side (Node + TS)
Implements `DESKTOP-RESPONDER-CONTRACT.md` v1:
- `identity.ts` — deviceId + X25519 + Ed25519 keys (file store dev/test;
  safeStorage is the adapter's job).
- `relay-client.ts` — outbound wss, signed hellos (byte-exact PROMPT-10
  construction), backoff reconnect, outbox drain.
- `pairing.ts` — Noise IK responder, QR ref rotation (20s/60s/single-use),
  re-handshake vs fresh-pairing distinguisher, verification codes
  (`formatVerificationCode`), one trusted phone (V1), revoke both directions,
  hello-pubkey capture from signed hellos.
- `e2e.ts` — per-peer `E2EState` registry; **reset on every new Noise
  session** (contract §5).
- `approvals.ts` — v1.6 verification gate, exact 5-step order: pending
  check → recompute `requestHash` over the stored sent object (constant-time
  compare) → Ed25519 verify vs PINNED phone key → skew/ID checks →
  single-use consume → `resolveApproval`. `not_me` → security event. 30s
  expiry sweep → auto-deny. Kill → auto-deny pending.
- `idempotency.ts` — `IdempotencyLog`: done/in-flight/miss checked BEFORE any
  engine call; `onError` records failures as done; 24h TTL + 10k LRU;
  persisted across restarts. This is what makes reconnects safe.
- `files.ts` — §10 pipeline: offer validation (25 MB cap, mime allowlist,
  32-hex transferId, 64-hex sha256) → accept/reject → strict-sequenced
  64 KB chunks → SHA-256 verify → store by generated `fileId`
  (traversal-proof) → `attachFile`. Max 4 concurrent transfers.
- `chat.ts` — §9: `chat_message` → `EnginePort.chat` → ordered `chat_token`
  stream → `chat_done`; approvals may arrive mid-turn.
- `responder.ts` — dispatcher: relay → Noise sessions → E2E open →
  allowlisted handlers → `EnginePort`. Unknown kinds ignored + counted.
  Malformed → ignored. Crypto failure → teardown + security event (JSONL).
- `engine-port.ts` — the narrow port: `getStatus`, `listSessions`,
  `sendInstruction`, `chat`, `kill`, `attachFile`, `onApprovalRequest`,
  `onStatusChanged`, `resolveApproval`. Verbatim from contract §14.
- `fake-engine.ts` — deterministic fake for tests (scripted chat,
  programmable approvals/failures, counters, injectable clock).
- Tests: `integration-test.mjs` — **13/13 green** on real sockets + real
  Noise + real phone stack (no mocked crypto): pairing, re-handshake+E2E
  reset, replay, chat, approval v1.6 + attack cases, idempotency, kill,
  file transfer (incl. oversize/traversal/corruption), recovery,
  hello-capture, failure idempotency, transfer cap, malformed key.

### Docs
- `DESKTOP-RESPONDER-CONTRACT.md` v1 (verified + corrected).
- `LEDGER.md` — prompt-by-prompt build log.
- `PROMPT-*.md` / `FIX-*.md` — supervision trail.

## 6. Security model (as built)

1. **Transport**: signed hellos + TOFU pinning at both relays; 120s hello
   freshness (cloud); 256 KB frame caps; rate limits.
2. **Pairing**: QR ref (20s rotation, 60s expiry, single-use) → Noise IK →
   human verification-code comparison → one trusted phone (V1). Re-pairing
   replaces only with explicit confirmation + code check.
3. **E2E**: every app message is a `SealedFrame` (seq, bound headers)
   inside Noise transport encryption. Seq resets on every new session;
   strictly monotonic within a session; duplicates/replays rejected.
4. **Authorization**: 6-layer (§6 of contract) — transport → trust →
   attribution → capability allowlist (EnginePort only) → no self-execution
   → deny by default.
5. **Approvals**: v1.6 gate (§7). Signature alone is insufficient; request
   binding is mandatory. Engine never hears about failures.
6. **Execution**: idempotency log (§8) — reconnect redelivery can never
   re-execute, including failures.
7. **Files**: caps → strict sequencing → SHA-256 → fileId storage → engine
   only via `attachFile`. Engine never sees unverified bytes.
8. **Audit**: JSONL security log (seed of the V3 audit ledger).

## 7. Data flows

### Pairing (phone + laptop)
QR scan → `pairing_request` (Noise msg1 + ref) → desktop validates ref (or
pinned key for re-handshake) → `pairing_grant` (msg2) → both derive
verification code from handshake hash → human compares → trust record
written (both sides) → E2E session live.

### Remote control (laptop awake)
Phone → relay (ciphertext) → responder → E2E open → handler → `EnginePort`
→ engine acts. Tool needs approval → `approval_request` → phone card →
biometric → signed decision → v1.6 gate → `resolveApproval` → engine
continues. Kill → `kill_request` → engine aborts → pending approvals
auto-denied.

### Standalone chat (V2, planned)
Phone/desktop → AI gateway (auth + quota) → provider → tokens stream back.
Remote MCP servers reachable from the gateway for plugins.

### Files (built: phone→laptop; V2: phone→gateway)
`file_offer` → validate → `file_accept` → ordered `file_chunk`s →
`file_done` → SHA-256 verify → inbox by `fileId` → engine ingests
(OCR/docs — `~/Bimax` task).

## 8. What is next (ordered)

1. **FIX-15** (issued): phone resets E2E state on new Noise session.
2. **`~/Bimax` adapter** (Phase 3): thin mapping of the real engine to
   `EnginePort` — `onApprovalRequest` fires BEFORE tool execution;
   `resolveApproval` suspends the tool; identity keys move to safeStorage;
   pairing UI hooks (QR display, verification code, confirm). **This is what
   makes the existing phone UI drive a real laptop.**
3. **Phone chat UI** (Phase 4): ChatGPT-like chat screen; remote-control
   tabs (sessions/status/approvals/files). Uses v1.7 kinds already in the
   protocol.
4. **AI gateway** (V2): Cloudflare Worker — holds provider keys, auth via
   Supabase, per-user metering/quotas, streams chat, executes remote MCP.
5. **Standalone phone chat** (V2): phone → gateway direct; no laptop needed.
6. **Ingest pipeline** (`~/Bimax` task): fileId → type sniff → text extract
   (PDF text layer → OCR → vision fallback; xlsx → tables; docx → md).
   Powers "upload anything" on both surfaces.
7. **Plugins** (V2): approved list first — GitHub, Google Drive, Notion,
   Vercel, Hugging Face, Google Calendar. Local MCP on desktop; remote MCP
   via gateway on phone.
8. **V2 product**: Supabase Auth (Google/GitHub/Email+OTP, one SDK for phone
   + desktop), device registry, FCM push with lock-screen actions, Play
   listing, R2-hosted APK + in-app updates + published SHA-256.
9. **V3 moat**: diff-summary cards, prompt-detection approvals,
   approval-fatigue guards, secret firewall, multi-desktop, audit ledger.

## 9. Lessons from Claude / ChatGPT architectures (2026-10-13 research)

What they do, and what we take:
- **Nobody runs models on-device.** All inference is cloud. The split that
  matters is *tool execution*. We already match the best pattern: tools run
  on the user's machine (like Claude Desktop's local MCP / Claude Code),
  not server-side (like ChatGPT's connectors).
- **Claude Desktop = Electron + local MCP over stdio.** This validates our
  responder architecture: local agent runtime, cloud model. Our E2E +
  approvals layer is the part they don't have.
- **ChatGPT = server-side everything + new unified desktop driving a local
  Rust agent.** Validates the "desktop as agent host" direction; we keep
  the privacy advantage (their cloud sees your files; our relay sees
  ciphertext).
- **Mobile is native everywhere** (Swift / Kotlin). We use Expo (one
  codebase, iOS from day one) — a deliberate speed tradeoff; revisit if
  the app outgrows it.
- **Voice**: ChatGPT realtime full-duplex vs Claude turn-based. Not V1 for
  us; note for later.
- **Files**: both upload to cloud object storage and parse server-side. We
  differ: phone→laptop direct, parse on-device. Keep it — it's the privacy
  story.
- **What NOT to copy**: ChatGPT's server-side tool execution (kills our
  privacy moat); Claude's split-brain (Desktop ≠ Code ≠ web — we keep one
  engine, one protocol).

## 10. Open questions (decided later, not now)

- Exact quota math per tier (needs real usage data from the student survey).
- Top-up packs vs hard monthly cap.
- When/if to go native mobile (Expo limits).
- Voice mode architecture.
- Multi-phone / multi-desktop (V3).
- Desktop→phone file transfer (protocol extension point, not V1).
