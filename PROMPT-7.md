# Bimax Mobile — Prompt #7: Session provider + approvals

Copy everything below the line into Antigravity as one prompt.

---

You are building the app layer for Bimax mobile. Context: companion remote; Prompts #1–6 + Fix #1 built the transport, crypto, pairing, and session primitives. Now: a single relay-client owner for the whole app, automatic re-handshake on app start, and the approval flow — approval cards, biometric confirmation, and signed decisions.

STACK (exact): TypeScript strict. One new dependency, architect-specified: `expo-local-authentication` (install via `npx expo install expo-local-authentication`). No other new dependencies. No Buffer, no `as any`.

TASK:
1. `apps/mobile/lib/crypto/secure-store.ts` — add trusted-desktop storage:
   - `export const BIMAX_TRUSTED_DESKTOP = "bimax_trusted_desktop";`
   - `export interface TrustedDesktop { deviceId: string; staticPublicKeyB64: string; relayUrl: string; }`
   - `saveTrustedDesktop(record: TrustedDesktop): Promise<void>` (JSON.stringify into secure store; validate the three fields are non-empty strings, throw otherwise)
   - `loadTrustedDesktop(): Promise<TrustedDesktop | null>` (parse; return null on missing; throw on corrupt JSON)
   - `clearTrustedDesktop(): Promise<void>`
2. `apps/mobile/app/pair.tsx` — small edit: in the "Codes match — Done" button handler, before `router.back()`, save the trusted desktop:
```ts
const { saveTrustedDesktop } = await import("../lib/crypto/secure-store");
// (Prefer a static import at the top of the file instead of a dynamic import
// if the module is already imported there — do not add a second import path.)
await saveTrustedDesktop({
  deviceId: advert.desktopDeviceId,
  staticPublicKeyB64: advert.desktopPublicKey,
  relayUrl: advert.relayUrl,
});
```
   (`advert` is already in component state; guard against null.)
3. `apps/mobile/lib/session/provider.tsx` (new file) — the single relay-client owner:
   - `RelayProvider`: a React context provider + `useRelayContext()` hook.
   - On mount: `deviceId = await getOrCreateDeviceId()`; `trusted = await loadTrustedDesktop()`; if no trusted desktop, stay idle (expose status `"idle"`).
   - If trusted desktop exists: create ONE `RelayClient` (to `trusted.relayUrl`, role `"mobile"`, global WebSocket), create a `PairingManager`, and automatically re-handshake: synthesize an advertisement `{ relayUrl: trusted.relayUrl, ref: "rehandshake-" + random, desktopDeviceId: trusted.deviceId, desktopPublicKey: trusted.staticPublicKeyB64, app: "bimax" }` and call `beginPairing` → send the request on connect. (The future desktop auto-approves pairing_requests from already-known static keys — note this contract in a code comment.)
   - Incoming envelope routing in `onMessage`: `pairing_grant` → `pairingManager.handleGrant` → store session in a `sessions` map (also clear any approvals/state for that peer on failure); `approval_request` → add to the approvals store (section 4); `presence` → update a `presenceByDevice` map; everything else → ignored.
   - Exposes via context: `{ status: ClientStatus | "idle"; sessions: EstablishedSession[]; getSession(peerId): EstablishedSession | undefined; pendingApprovals: ToolApprovalRequest[]; approve(approvalId: string): Promise<void>; deny(approvalId: string, reason?: "not_me" | "mistake"): Promise<void>; send(env): void; }`
   - `approve`/`deny` are implemented in section 4's logic; the provider wires them to the approvals store + relay send. Exactly one RelayClient per app lifetime; cleanup on unmount.
4. `apps/mobile/lib/approvals/approvals.ts` (new directory):
   - `addApproval(req: ToolApprovalRequest): void`, `getPending(): ToolApprovalRequest[]` (filters out expired), `removeApproval(approvalId: string): void`, `isExpired(req): boolean` (`Date.now() > req.expiresAt`). Validate required fields on add; throw on duplicates.
   - `buildApprovalDecision(req, decision: "approve" | "deny", denyReason?): Omit<ApprovalDecision, "signature">` — `{ approvalId: req.approvalId, sessionId: req.sessionId, decision, decidedAt: Date.now(), ...(denyReason ? { denyReason } : {}) }`.
   - `signApprovalDecision(unsigned, ed25519PrivateKey: Uint8Array): ApprovalDecision` — `signature = bytesToBase64(ed25519Sign(privateKey, utf8(canonicalJson(unsigned))))`. (UTF-8 encode the canonical JSON string to bytes first.)
   - `verifyApprovalDecision(dec: ApprovalDecision, publicKey: Uint8Array): boolean` — strip `signature`, recompute canonical bytes, `ed25519Verify`; return false (not throw) on any malformed input.
   - The biometric gate is INJECTED, not imported: `decideWithBiometric(opts: { requestBiometric: () => Promise<boolean>; build: () => Omit<ApprovalDecision, "signature">; sign: (unsigned) => ApprovalDecision; onDecision: (dec: ApprovalDecision) => void; onDenied: (reason: string) => void; }): Promise<void>` — if `requestBiometric()` resolves false, call `onDenied("biometric-failed")` and do NOT sign; otherwise sign and call `onDecision`. (The UI passes the real expo-local-authentication call; tests pass mocks.)
5. UI — `apps/mobile/app/approvals.tsx` (Expo Router screen):
   - Reads `pendingApprovals`, `approve`, `deny` from `useRelayContext()`.
   - Each pending approval renders a card: tool name (large), summary, detail in monospace (scrollable if long), session id, live "expires in Ns" countdown, Approve / Deny buttons.
   - Approve button: `LocalAuthentication.authenticateAsync({ promptMessage: `Approve ${tool}?`, disableDeviceFallback: true })` → on success, load the Ed25519 private key (`loadDeviceKey(BIMAX_ED25519_PRIV)`; if missing, generate via getOrCreateEd25519Keypair first), sign, send `Envelope<"approval_decision", ApprovalDecision>` `{ v: 1, id: random, ts, from: deviceId, to: <desktop device id>, kind: "approval_decision", payload: decision }` via the provider's `send`, remove from pending. On biometric failure/cancel, show "Authentication failed" and do nothing.
   - Deny button: small reason selector ("It wasn't me" → `not_me`, "Mistake" → `mistake`, or plain deny) → same sign+send flow.
   - Empty state: "No pending approvals."
   - Add an "Approvals" link button on `apps/mobile/app/index.tsx` next to the "Pair a device" button.
   - Wrap the app root so `RelayProvider` is available on the approvals screen (check how the scaffold wires providers; add it at the layout level if there is one, otherwise wrap the approvals screen directly — do not restructure the router).
6. TEST — `apps/mobile/test/approvals-test.mjs` (plain Node):
   - Compile with tsc (same flags as previous tests): `approvals.ts`, `keys.ts`, `base64.ts`, `session.ts`, `noise.ts`, `pairing.ts` into a tmpdir; require them. (secure-store.ts and provider.tsx excluded — Expo/React runtime only.)
   - STEP 1 (sign/verify): build a decision for a fake approval request, sign with a fresh Ed25519 key, assert `verifyApprovalDecision` true; tamper `decidedAt` → assert false; verify with a wrong public key → assert false. PASS/FAIL.
   - STEP 2 (approval store): add two approvals (one already expired), assert `getPending()` returns only the live one; `removeApproval` removes it; re-adding the same approvalId throws. PASS/FAIL.
   - STEP 3 (re-handshake): simulate a trusted desktop — run a full pairing once (like pairing-test STEP 1), then simulate app restart: new PairingManager with the SAME static keypair, `beginPairing` with a synthesized re-handshake advert (same desktop keys) → responder (same static keys) → assert a second session establishes and handshake hashes match. (Proves re-handshake works with known keys, no QR.) PASS/FAIL.
   - STEP 4 (biometric gate): call `decideWithBiometric` with `requestBiometric: async () => false` → assert `onDecision` NOT called and `onDenied` called with `"biometric-failed"`; with `async () => true` → assert `onDecision` called with a verifiable signed decision. PASS/FAIL.
   - Print PASS/FAIL per step, delete tmpdir, exit 0 iff all pass.

SCOPE — DO NOT DO:
- No E2E payload framing (next prompt). No session list screen. No changes to apps/relay, the relay client, protocol, or existing crypto/session files except: secure-store.ts additions, the pair.tsx trusted-save edit, and the index.tsx link.
- No other new dependencies. Do not restructure the Expo Router layout.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/approvals-test.mjs` → all four steps PASS

RETURN FOR REVIEW (paste all five):
1. The file tree of apps/mobile/lib/approvals, apps/mobile/lib/session, apps/mobile/app, apps/mobile/test
2. The FULL text of apps/mobile/lib/approvals/approvals.ts
3. The FULL output of the approvals test
4. The terminal output of acceptance commands 1–3
5. Confirmation of the secure-store additions + pair.tsx edit (paste the changed hunks)
