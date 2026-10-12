# Bimax Mobile — Prompt #10: protocol v1.5 + dual-mode phone (LAN / Cloudflare-ready)

Copy everything below the line into Antigravity as one prompt.

---

Architecture pivot. The relay is being split in two: a Cloudflare Workers + Durable Objects relay for internet use (next prompt), and the existing Node relay kept for LAN mode (phone + laptop on the same WiFi). The wire protocol does NOT change — only the relay implementation and which URL the phone dials. This prompt lays the protocol and phone foundation. It also kills two items from the dumb-list: unauthenticated hellos (deviceId squatting) and fire-and-forget kill.

PROTOCOL v1.5 — apply these exact changes to packages/protocol/src/index.ts:
1. `DeviceHello` gains two REQUIRED fields:
```ts
helloPubkey: string;    // base64 Ed25519 device public key (the approval-signing key)
helloSignature: string; // base64 Ed25519 signature over the canonical JSON bytes of
                        // { id, ts, from, deviceId, role, helloPubkey }
                        // where id/ts/from are the hello envelope's own fields
```
   Document the relay-side semantics in a comment above the interface: TOFU — pin `helloPubkey` per `deviceId` on first hello; on later hellos, reject when the pubkey differs (possible squat) or the signature is invalid or `|now - ts| > 120000` ms (replay window).
2. `PairingAdvertisement` gains `lanRelayUrl?: string` — e.g. `ws://192.168.1.5:8787`; absent when the desktop has no LAN relay.
3. `KillRequest` gains `idempotencyKey: string` (required in v1.5; the desktop does not exist yet so there is no compat concern).
4. MessageKind gains `"kill_result"`; add:
```ts
export interface KillResult {
  idempotencyKey: string;
  ok: boolean;
  detail?: string;
  at: number;
}
```
5. Version comment → v1.5 with a note.

STACK (exact): TypeScript strict. ZERO new dependencies. No Buffer, no `as any`.

TASK:
1. **Protocol**: the v1.5 changes above. This is the ONLY protocol change.
2. **Relay client** (`apps/mobile/lib/relay/client.ts`) — hello signing:
   - Constructor options gain `helloSigner?: { pubkeyB64: string; sign: (msg: Uint8Array) => Promise<Uint8Array> }`.
   - When building the hello envelope: if `helloSigner` is present, compute `sig = await helloSigner.sign(utf8(canonicalJson({ id, ts, from, deviceId, role, helloPubkey: helloSigner.pubkeyB64 })))` using the envelope's own id/ts/from, and set `payload.helloPubkey` / `payload.helloSignature` (base64). If absent, send the legacy hello without the new fields (keeps existing tests green).
   - Import `canonicalJson` from `../crypto/keys` and base64 helpers from `../crypto/base64` (no cycle: crypto never imports relay).
3. **Secure store** (`apps/mobile/lib/crypto/secure-store.ts`): `TrustedDesktop` gains `lanRelayUrl?: string` and `lastWorking?: "lan" | "cloud"`; persist both in `saveTrustedDesktop`.
4. **`app/pair.tsx`**: when saving the trusted desktop, include `lanRelayUrl: advert.lanRelayUrl`.
5. **Provider** (`apps/mobile/lib/session/provider.tsx`):
   - In `connectToRelay`, pass `helloSigner` built from the Ed25519 device keypair: `{ pubkeyB64, sign: async (msg) => edSign(msg, privKey) }`. Load the keypair once in the init effect (reuse the existing `getOrCreateEd25519Keypair`/`getEd25519PrivateKey` helpers; derive the public key with the existing ed25519 helper — check what those helpers return and use the codebase's own functions, no new crypto code).
   - Add `statusRef` mirroring the `status` state (update it inside the `onStatus` callback you pass to the client).
   - Dual-URL auto-connect in the init effect (replaces the single `connectToRelay(trusted.relayUrl)` call): build the ordered list — if `trusted.lanRelayUrl` exists and `trusted.lastWorking !== "cloud"`, try `[lanRelayUrl, relayUrl]`; otherwise `[relayUrl, ...(lanRelayUrl ? [lanRelayUrl] : [])]`. For each URL in order: `connectToRelay(url)`, then poll `statusRef` every 150ms for up to 4000ms; first URL to reach `"online"` wins — persist `lastWorking` (`"lan"`/`"cloud"` based on which URL won) via `saveTrustedDesktop`. If all fail, `setStatus("idle")`. (`pairWithDesktop` is unchanged — it dials the QR's URL directly.)
   - Kill ack: `const [lastKillAck, setLastKillAck] = useState<KillResult | null>(null)`, exposed on the context. `sendKill` generates `idempotencyKey: "kill-" + Math.random().toString(36).slice(2)`, includes it in the `KillRequest`, and resets `setLastKillAck(null)`. New `handleIncoming` branch for `kill_result`: validate `idempotencyKey` is a non-empty string and `typeof ok === "boolean"`; `setLastKillAck({ idempotencyKey, ok, detail: typeof detail === "string" ? detail.slice(0, 300) : undefined, at: typeof at === "number" && Number.isFinite(at) ? at : Date.now() })`. Ignore malformed silently.
6. **`app/index.tsx`** — minimal kill-ack UI: destructure `lastKillAck` from the context; under the Kill button render `{lastKillAck ? <Text style={...}>{lastKillAck.ok ? "✓ Kill acknowledged" : `✗ Kill failed${lastKillAck.detail ? `: ${lastKillAck.detail}` : ""}`}</Text> : null}` reusing existing style patterns (no new StyleSheet entries needed beyond a small text style if you want one).
7. **TEST** — `apps/mobile/test/hello-auth-test.mjs` (plain Node, compile `keys.ts` + `base64.ts` to a tmpdir; use the same noble ed25519 import pattern `crypto-test.mjs` uses):
   - STEP 1 (sign/verify roundtrip): generate an Ed25519 keypair, build `{id, ts, from, deviceId, role, helloPubkey}`, canonical-JSON → sign → verify with the public key → PASS.
   - STEP 2 (ts tamper): flip `ts` by 1 → verify FAILS. PASS/FAIL.
   - STEP 3 (wrong key): verify with a different public key → FAILS. PASS/FAIL.
   - STEP 4 (TOFU pin): simulate a pin map — first hello pins the pubkey; a second hello with a different pubkey is flagged as a mismatch. PASS/FAIL.
   - STEP 5 (kill shapes): build a `KillRequest` with idempotencyKey and a matching `KillResult`; assert the keys match and required fields are present. PASS/FAIL.
   - Print PASS/FAIL per step, delete tmpdir, exit 0 iff all pass.

SCOPE — DO NOT DO:
- No Cloudflare code (next prompt). No changes to `apps/relay` (the Node relay keeps accepting legacy hellos for now; its auth backport is a later prompt). No push notifications. No other hardening. The ONLY protocol change is v1.5 above. Do not persist anything new besides the two TrustedDesktop fields.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/hello-auth-test.mjs` → all five steps PASS
5. Regression: `node apps/mobile/test/pairing-test.mjs && node apps/mobile/test/approvals-test.mjs && node apps/mobile/test/e2e-test.mjs && node apps/mobile/test/control-test.mjs` → all steps PASS

RETURN FOR REVIEW (paste all five):
1. The file tree of apps/mobile/lib/relay, apps/mobile/lib/crypto, apps/mobile/test
2. The protocol v1.5 diff
3. The hello-signing code in client.ts + the provider's helloSigner wiring, dual-URL connect logic, and kill_result branch
4. The FULL terminal output of acceptance commands 1–5
5. Confirmation that existing relay-smoke tests still pass unmodified (legacy hello path)
