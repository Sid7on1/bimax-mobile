# Bimax Mobile — Prompt #6: Pairing flow (QR scan + Noise handshake over relay)

Copy everything below the line into Antigravity as one prompt.

---

You are building the pairing user flow for Bimax mobile. Context: companion remote; Prompts #1–5 built the scaffold, relay server, relay client, crypto primitives, and a verified Noise_IK handshake (byte-identical to the official test vectors). Now wire it into something a human can use: scan the desktop's QR code, run the Noise handshake THROUGH the relay, and establish an encrypted session.

PROTOCOL v1.2 — apply these exact changes to packages/protocol/src/index.ts:
1. In `PairingRequest`, add required field `handshakeMessage: string` (base64 Noise handshake message 1). OLD:
```ts
export interface PairingRequest {
  ref: string;
  mobileDeviceId: string;
  mobilePublicKey: string; // base64 X25519
}
```
NEW:
```ts
export interface PairingRequest {
  ref: string;
  mobileDeviceId: string;
  mobilePublicKey: string; // base64 X25519
  handshakeMessage: string; // base64 Noise handshake message 1
}
```
2. In `PairingGrant`, add required field `handshakeMessage: string` (base64 Noise handshake message 2). OLD:
```ts
export interface PairingGrant {
  mobileDeviceId: string;
  grantedAt: number;
}
```
NEW:
```ts
export interface PairingGrant {
  mobileDeviceId: string;
  grantedAt: number;
  handshakeMessage: string; // base64 Noise handshake message 2
}
```
3. Update the version comment at the top of the file from v1.1 to v1.2 and note the change.

STACK (exact): TypeScript strict. One new dependency, architect-specified: `expo-camera` (install via `npx expo install expo-camera`). No other new dependencies. No Buffer, no `as any`.

TASK:
1. `apps/mobile/lib/crypto/secure-store.ts` — add:
   - `export const BIMAX_DEVICE_ID = "bimax_device_id";`
   - `export async function getOrCreateDeviceId(): Promise<string>` — loads the stored id or generates `"m-" + Math.random().toString(36).slice(2) + Date.now().toString(36)`, stores it, returns it.
2. `apps/mobile/lib/crypto/pairing.ts` — in `validateGrant`, additionally require `payload.handshakeMessage` to be a non-empty string; throw naming the field otherwise.
3. `apps/mobile/lib/session/session.ts` (new directory):
   - `export interface EstablishedSession { peerDeviceId: string; handshakeHash: Uint8Array; establishedAt: number; encrypt(plaintext: Uint8Array): Uint8Array; decrypt(ciphertext: Uint8Array): Uint8Array; }`
   - `export function formatVerificationCode(hash: Uint8Array): string` — takes the 32-byte handshake hash, reads the first 12 bytes as 6 big-endian uint16 values, formats each as 4 digits mod 10000, joins with "-". Example: `"1234-5678-9012-3456-7890-1234"`. Both sides display the same code; the user compares it with the desktop screen.
   - `export class PairingManager`:
     - Constructor: `{ deviceId: string; staticKeypair: KeyPair }` (the caller loads the keypair via getOrCreateX25519Keypair; the manager never touches expo-secure-store directly, keeping it Node-testable).
     - `beginPairing(advert: PairingAdvertisement): Envelope<"pairing_request", PairingRequest>` — creates a NoiseIKInitiator with remoteStaticPublicKey = base64ToBytes(advert.desktopPublicKey); writeMessage1 with EMPTY payload (the ref travels in the envelope, not the Noise payload); builds the envelope `{ v: 1, id: random, ts: Date.now(), from: deviceId, to: advert.desktopDeviceId, kind: "pairing_request", payload: { ref: advert.ref, mobileDeviceId: deviceId, mobilePublicKey: base64(static pubkey), handshakeMessage: base64(msg1) } }`; stores the pending initiator keyed by advert.desktopDeviceId. Throws if a pairing is already pending for that device.
     - `handleGrant(env: Envelope<"pairing_grant", PairingGrant>): EstablishedSession` — runs validateGrant (now also checks handshakeMessage); looks up the pending initiator by `env.from`; throws if none; readMessage2(base64ToBytes(payload.handshakeMessage)) (throws on failure); builds the EstablishedSession (encrypt/decrypt bound to the completed initiator); clears the pending entry; returns the session.
     - `getSession(peerDeviceId: string): EstablishedSession | undefined` and `hasPending(deviceId: string): boolean`.
   - No relay I/O inside PairingManager — it produces and consumes envelopes; the UI wires it to the relay client.
4. UI — `apps/mobile/app/pair.tsx` (Expo Router screen):
   - State machine: `idle → scanning → confirming → pairing → verifying → done`, plus `error`.
   - `idle`: big button "Scan desktop QR" + secondary "Enter code manually".
   - `scanning`: expo-camera full-screen with barcode scanner restricted to QR; on scan → parseAdvertisement; success → `confirming`, failure → show error inline and keep scanning. Request camera permission on mount; if denied, show a message with a button to the manual entry.
   - Manual entry: multiline text input for the QR JSON + "Continue" → same parse path.
   - `confirming`: card showing desktopDeviceId and relayUrl + "Pair with this device" / "Rescan" buttons.
   - `pairing`: on entering this state: `deviceId = await getOrCreateDeviceId()`, `staticKeypair = await getOrCreateX25519Keypair()`, create PairingManager, connect a standalone RelayClient to advert.relayUrl (this flow owns its lifecycle; close it on unmount), beginPairing → send requestEnv → wait for a `pairing_grant` envelope (60s timeout, spinner + "Waiting for desktop approval…"). On grant → handleGrant → `verifying`.
   - `verifying`: show formatVerificationCode(handshakeHash) large + "Compare this code with the one on your desktop" + "Codes match — Done" button (→ `done`, navigates back) + "Doesn't match" (→ `error` with guidance to rescan; this is the MITM alarm).
   - `error`: message + Retry button (→ `idle`).
   - Keep the existing placeholder screen untouched; add a "Pair a device" button linking to `/pair`.
   - No styling framework beyond what the scaffold already uses; keep it clean and simple.
5. TEST — `apps/mobile/test/pairing-test.mjs` (plain Node):
   - Compile with tsc (same flags as the noise test): `session.ts`, `noise.ts`, `keys.ts`, `base64.ts`, `pairing.ts` into a tmpdir; require them. (secure-store.ts excluded — Expo runtime only.)
   - Simulate the DESKTOP side in-process with NoiseIKResponder (fixed test keys) + a relay client on a spawned real relay (same pattern as relay-smoke.mjs, test port).
   - Build a fake advertisement: relayUrl = test relay, ref = "test-ref", desktopDeviceId = "desktop-1", desktopPublicKey = base64(responder static pub), app = "bimax".
   - STEP 1 (full pairing over relay): phone PairingManager.beginPairing(advert) → send requestEnv via relay → desktop simulator receives pairing_request, runs readMessage1, builds pairing_grant with writeMessage2 → sends via relay → phone handleGrant → assert session established; assert phone and desktop handshake hashes are byte-equal. PASS/FAIL.
   - STEP 2 (tampered grant): flip one byte of the grant's handshakeMessage → assert phone handleGrant THROWS. PASS/FAIL.
   - STEP 3 (grant with no pending pairing): desktop sends a grant for an unknown device → assert handleGrant THROWS. PASS/FAIL.
   - STEP 4 (session transport): phone session.encrypt → desktop responder decrypt → assert roundtrip. PASS/FAIL.
   - STEP 5 (verification code): assert formatVerificationCode is deterministic (same hash → same string) and matches the pattern `^\\d{4}(-\\d{4}){5}$`. PASS/FAIL.
   - Print PASS/FAIL per step, kill children, delete tmpdir, exit 0 iff all pass.

SCOPE — DO NOT DO:
- No approval UI, no biometric signing (next prompt). No session list screen.
- No changes to apps/relay, the relay client, or crypto files except: the two protocol interfaces, secure-store.ts additions, and the validateGrant handshakeMessage check.
- No other new dependencies. Do not redesign the placeholder screen.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/pairing-test.mjs` → all five steps PASS

RETURN FOR REVIEW (paste all five):
1. The file tree of apps/mobile/lib/session, apps/mobile/app, apps/mobile/lib/crypto, apps/mobile/test
2. The FULL text of apps/mobile/lib/session/session.ts
3. The FULL output of the pairing test
4. The terminal output of acceptance commands 1–3
5. Confirmation of the protocol v1.2 changes (paste the changed interfaces)
