# Bimax Mobile — Prompt #8: E2E payload framing

Copy everything below the line into Antigravity as one prompt.

---

You are building end-to-end encryption for Bimax mobile's app traffic. Context: companion remote; Prompts #1–7 + Fixes #1–2 built the transport, Noise_IK sessions, pairing, and approvals. The Noise transport keys exist and work — but approval decisions still travel as plaintext JSON that the relay could read. After this prompt, the relay sees only routing headers and opaque ciphertext.

Design (from the security research — implement exactly this):
- Outer envelope headers stay plaintext and minimal: `{v, id, from, to, kind}` — only what the relay needs to route and dedupe.
- Everything semantic moves inside the encrypted body (Signal sealed-sender model).
- The routing headers are BOUND into the encrypted frame: the receiver verifies the inner copy matches the outer headers, so the relay cannot tamper with routing undetected.
- New envelope kind `"encrypted"` carries `{ ciphertext: base64 }`. The inner content is a sealed frame, never a nested "encrypted".
- Nonces: the Noise transport's internal per-direction counters (never persisted, never reused — re-handshake on restart, already the implemented behavior).
- Replay/duplicates: the relay redelivers at-least-once, so the receiver dedupes on envelope `id` BEFORE decrypting, and enforces a strictly-increasing per-peer `seq` inside the frame.

PROTOCOL v1.3 — apply these exact changes to packages/protocol/src/index.ts:
1. Add `"encrypted"` to the `MessageKind` union.
2. Add:
```ts
export interface EncryptedPayload {
  ciphertext: string; // base64: SealedFrame encrypted with the Noise transport key
}
```
3. Update the version comment at the top from v1.2 to v1.3 and note the change.

STACK (exact): TypeScript strict. ZERO new dependencies. No Buffer, no `as any`.

TASK:
1. `apps/mobile/lib/e2e/framing.ts` (new directory) — pure functions, no I/O:
```ts
import type { MessageKind } from "@bimax/protocol";
import type { EstablishedSession } from "../session/session";

export interface SealedFrame {
  fver: 1;
  innerKind: MessageKind; // never "encrypted"
  seq: number;            // sender's per-peer monotonic counter, starts at 0
  body: unknown;          // the original payload
  bound: { id: string; from: string; to: string }; // must equal the outer headers
}

export interface E2EState {
  sendSeq: number;
  recvHighestSeq: number;
  seenIds: Set<string>;
}

export function newE2EState(): E2EState; // { sendSeq: 0, recvHighestSeq: -1, seenIds: new Set() }

export function seal(
  session: EstablishedSession,
  state: E2EState,
  innerKind: MessageKind,
  body: unknown,
  outer: { id: string; from: string; to: string },
): string; // returns base64 ciphertext; increments state.sendSeq; throws if innerKind === "encrypted"

export type OpenResult =
  | { duplicate: true }
  | { duplicate: false; innerKind: MessageKind; body: unknown };

export function open(
  session: EstablishedSession,
  state: E2EState,
  outer: { id: string; from: string; to: string; kind: string; ciphertextB64: string },
): OpenResult; // throws on tamper / header mismatch / seq replay; returns {duplicate:true} for seen ids WITHOUT decrypting
```
   - `seal`: build the SealedFrame, canonical-JSON it, UTF-8 encode, `session.encrypt`, base64 the result. Increment `sendSeq` AFTER successful encrypt. Cap `seenIds` at 2000 entries (evict oldest via insertion order) to bound memory.
   - `open`: (1) if `state.seenIds.has(outer.id)` return `{duplicate:true}` — BEFORE any decrypt; (2) base64-decode, `session.decrypt` (throws on tamper — propagate); (3) JSON-parse and validate: `fver === 1`, `innerKind !== "encrypted"`, `typeof seq === "number"`, `bound.id === outer.id && bound.from === outer.from && bound.to === outer.to` — throw naming the failure otherwise; (4) if `seq <= state.recvHighestSeq` throw (replay); (5) add id to seenIds (with the 2000 cap), set `recvHighestSeq = seq`, return `{duplicate:false, innerKind, body}`.
   - `apps/mobile/lib/e2e/index.ts` barrel.
2. `apps/mobile/lib/session/provider.tsx` — wire E2E in:
   - Add `sessionsRef` (a `useRef<EstablishedSession[]>`) kept in sync wherever `setSessions` is called, so `handleIncoming` can look up sessions without stale closures. (Alternatively refactor sessions to live in the ref with a state mirror — whichever is cleaner, but the lookup must never go stale.)
   - Add `e2eStateRef = useRef(new Map<string, E2EState>())` keyed by peer deviceId, with a `getE2EState(peerId)` helper that creates on demand.
   - Add to the context: `sendEncrypted(to: string, kind: MessageKind, payload: unknown): void` — looks up the session for `to` (throw if none), builds outer `{id: random, from: deviceIdRef.current, to}`, seals via `seal(session, state, kind, payload, outer)`, and sends `Envelope<"encrypted", EncryptedPayload>` `{ v:1, id, ts: Date.now(), from, to, kind:"encrypted", payload:{ciphertext} }` through the client. If no client exists, throw (do NOT silently drop).
   - In `handleIncoming`, FIRST branch: `if (env.kind === "encrypted")` → find session by `env.from` (ignore the envelope if no session — do not throw); `open(session, state, {id: env.id, from: env.from, to: deviceIdRef.current, kind: env.kind, ciphertextB64: (env.payload as EncryptedPayload).ciphertext})`; if `duplicate` → return; else re-dispatch by calling `handleIncoming` with a synthetic inner envelope `{ v: env.v, id: env.id, ts: env.ts, from: env.from, to: deviceIdRef.current, kind: result.innerKind, payload: result.body }`. (Inner kind is never "encrypted" — `open` enforces this, so no infinite recursion.) Malformed `payload.ciphertext` (not a string) → ignore the envelope.
   - Migrate `approve()` and `deny()`: replace their `send(env)` of the `approval_decision` envelope with `sendEncrypted(desktopId, "approval_decision", signed)` where `desktopId = trustedRef.current?.deviceId` (throw if missing — no `"desktop"` fallback anymore).
   - Plaintext allowlist (sent via raw `send`, never encrypted): `hello`, `presence`, `delivery_ack`, `pairing_request`, `pairing_grant`, `encrypted` itself. Everything else the provider sends must go through `sendEncrypted`.
3. TEST — `apps/mobile/test/e2e-test.mjs` (plain Node):
   - Compile with tsc (same flags): `framing.ts`, `session.ts`, `noise.ts`, `keys.ts`, `base64.ts`, `pairing.ts` into a tmpdir; require them.
   - Establish two Noise sessions in-process (initiator + responder, like noise-test STEP 1) to get two `EstablishedSession`-shaped objects (wrap the Noise classes: `{peerDeviceId, handshakeHash, establishedAt, encrypt, decrypt}` — the test builds these adapters directly).
   - STEP 1 (roundtrip): seal a fake approval_decision body → open on the other side → assert innerKind/body match and headers bound. PASS/FAIL.
   - STEP 2 (tamper): flip a byte of the ciphertext → assert open THROWS. PASS/FAIL.
   - STEP 3 (header tampering): seal with outer `{id:"a", from:"x", to:"y"}`, then open with `from:"evil"` → assert THROWS (bound mismatch). PASS/FAIL.
   - STEP 4 (duplicates + replay): open the same envelope twice → second returns `{duplicate:true}` without throwing; then craft an envelope with an older `seq` but a fresh id → assert THROWS (replay). PASS/FAIL.
   - STEP 5 (wrong peer): seal with session A, open with session B (different keys) → assert THROWS. PASS/FAIL.
   - Print PASS/FAIL per step, delete tmpdir, exit 0 iff all pass.

SCOPE — DO NOT DO:
- No changes to apps/relay, the relay client, or crypto files. The ONLY protocol change is v1.3 (the `"encrypted"` kind + `EncryptedPayload`).
- Do not redesign the approvals UI. No new dependencies. Do not persist E2EState or transport keys anywhere.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/e2e-test.mjs` → all five steps PASS
5. Regression: `node apps/mobile/test/pairing-test.mjs` and `node apps/mobile/test/approvals-test.mjs` → all steps PASS

RETURN FOR REVIEW (paste all five):
1. The file tree of apps/mobile/lib/e2e, apps/mobile/lib/session, apps/mobile/test
2. The FULL text of apps/mobile/lib/e2e/framing.ts
3. The FULL output of the e2e test
4. The terminal output of acceptance commands 1–5
5. Confirmation of the provider wiring (paste the `sendEncrypted` function and the `encrypted` branch of `handleIncoming`) + the protocol v1.3 diff
