# Bimax Mobile — Prompt #4: Crypto primitives + secure storage + pairing messages

Copy everything below the line into Antigravity as one prompt.

---

You are building the cryptography layer for Bimax mobile. Context: companion remote; Prompts #1–3 built the scaffold, relay server, and mobile relay client. Before any pairing UI exists, we need correct, heavily tested crypto primitives. Crypto is the highest-risk code in this project — follow this spec exactly, do not improvise, do not reach for other libraries.

FIRST — DRIVE-BY FIXES from the Prompt #3 review (do these before anything else):
1. In apps/mobile/lib/relay/client.ts, the auto-ack is addressed `to: env.from`, which makes the relay forward the ack to the original sender as noise. The relay is the only consumer of acks. Change EXACTLY this line:
   OLD: `to: typeof env.from === "string" ? env.from : "relay",`
   NEW: `to: "relay",`
2. In apps/mobile/lib/relay/useRelay.ts, replace the `as any` cast with an explicit guard. OLD:
   `wsImpl: (typeof WebSocket !== "undefined" ? WebSocket : undefined) as any,`
   NEW:
   ```ts
   wsImpl: ((): WsImpl => {
     if (typeof WebSocket === "undefined") {
       throw new Error("useRelay: global WebSocket is not available");
     }
     return WebSocket as unknown as WsImpl;
   })(),
   ```
   (Add `type WsImpl` to the existing type import from "./client".)
3. In apps/mobile/lib/relay/client.ts, delete the redundant `getStatus()` method (keep the `get status()` getter). Confirm nothing references `getStatus()` — `npx tsc --noEmit` must still pass afterwards.

STACK (exact): TypeScript strict. New dependencies, all architect-specified: `@noble/curves`, `@noble/hashes`, `@noble/ciphers` (plain `npm install`), and `expo-secure-store` (install via `npx expo install expo-secure-store` so the version matches the SDK). Everything pure TypeScript — NO native crypto modules (they would break OTA updates). NO Buffer anywhere — React Native has none; use Uint8Array throughout.

TASK:
1. Create apps/mobile/lib/crypto/ with exactly these files:
   - base64.ts — `export function bytesToBase64(bytes: Uint8Array): string` and `export function base64ToBytes(s: string): Uint8Array`. Standard base64 (not URL-safe), correct padding. Zero dependencies. Throw Error on invalid input characters.
   - keys.ts —
     - `generateX25519Keypair(): { publicKey: Uint8Array; privateKey: Uint8Array }` (32 bytes each)
     - `generateEd25519Keypair(): { publicKey: Uint8Array; privateKey: Uint8Array }`
     - `x25519SharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array` (32-byte raw ECDH output)
     - `hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array`
     - `chachaEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array` and `chachaDecrypt(key, nonce, ciphertext, aad?): Uint8Array` — key must be 32 bytes, nonce 12 bytes; decrypt throws on authentication failure and never returns partial plaintext.
     - `ed25519Sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array` and `ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean`
     - `canonicalJson(value: unknown): string` — deterministic JSON: recursively sort object keys, no whitespace. Approval signatures sign this output, so both sides must produce identical bytes for identical values.
     - Every function validates input lengths and throws `Error` with a clear message on misuse (wrong key/nonce length, etc.). Never silently coerce or truncate.
   - secure-store.ts — thin wrapper over expo-secure-store:
     - `saveDeviceKey(name: string, privateKeyBase64: string): Promise<void>`
     - `loadDeviceKey(name: string): Promise<string | null>`
     - `deleteDeviceKey(name: string): Promise<void>`
     - `getOrCreateX25519Keypair(): Promise<{ publicKeyBase64: string }>` — loads key `bimax_x25519_priv` or generates + stores it (private as base64), returns public as base64. Same shape for ed25519 with key name `bimax_ed25519_priv`.
     - Key names as exported constants. NOTE: expo-secure-store cannot run in plain Node — this file is covered by `tsc --noEmit` + `eslint` only; the test script below does NOT import it.
   - pairing.ts — pure message builders/validators, no I/O:
     - `parseAdvertisement(qrText: string): PairingAdvertisement` — JSON.parse; validate all five fields (`relayUrl`, `ref`, `desktopDeviceId`, `desktopPublicKey`, `app`) are present with correct types and `app === "bimax"`; throw `Error` naming the offending field otherwise.
     - `buildPairingRequest(advert: PairingAdvertisement, mobileDeviceId: string, mobilePublicKeyBase64: string): Envelope<"pairing_request", PairingRequest>` — fills `v: 1`, random id, `ts: Date.now()`, `from: mobileDeviceId`, `to: advert.desktopDeviceId`, payload `{ ref: advert.ref, mobileDeviceId, mobilePublicKey: mobilePublicKeyBase64 }`.
     - `validateGrant(env: unknown): PairingGrant` — assert it is an object with `kind === "pairing_grant"` and a payload with string `mobileDeviceId` and number `grantedAt`; throw otherwise.
   - index.ts — barrel: `export * from "./base64"; export * from "./keys"; export * from "./secure-store"; export * from "./pairing";`

2. TEST — `apps/mobile/test/crypto-test.mjs` (plain Node, no new test dependencies):
   - At start, compile the testable lib: `npx tsc apps/mobile/lib/crypto/keys.ts apps/mobile/lib/crypto/base64.ts apps/mobile/lib/crypto/pairing.ts --outDir <tmpdir>/crypto-dist --module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck` via child_process (fail fast on error), then require the compiled files. (secure-store.ts is deliberately excluded — it needs the Expo runtime.)
   - STEP 1 (base64): roundtrip random arrays of length 0, 16, 32, 64; assert known vector bytes [104,101,108,108,111] → "aGVsbG8="; assert invalid characters throw. PASS/FAIL.
   - STEP 2 (ECDH): A and B generate x25519 pairs; assert `x25519SharedSecret(aPriv, bPub)` deep-equals `x25519SharedSecret(bPriv, aPub)` and is 32 bytes. PASS/FAIL.
   - STEP 3 (AEAD): derive a 32-byte key via hkdfSha256; encrypt "hello bimax" (utf8) with a random 12-byte nonce; decrypt → assert original bytes back; flip one bit of the ciphertext → assert decrypt THROWS. PASS/FAIL.
   - STEP 4 (signatures + canonical JSON): assert `canonicalJson({b:2,a:1}) === canonicalJson({a:1,b:2})`; sign the canonical bytes, assert verify true; assert verify with a different public key is false; assert verify on tampered message is false. PASS/FAIL.
   - STEP 5 (pairing messages): `parseAdvertisement` on a valid JSON string → returns the advertisement; on garbage JSON, on a missing field, and on `app !== "bimax"` → each throws. `buildPairingRequest` → assert `to === advert.desktopDeviceId` and `payload.ref === advert.ref`. PASS/FAIL.
   - Print PASS/FAIL per step, delete tmpdir, exit 0 only if all pass.

SCOPE — DO NOT DO:
- No Noise handshake state machine yet (next prompt). No QR scanner UI. No changes to apps/relay, packages/protocol, or the relay client except the three drive-by fixes above.
- No other new dependencies. No Buffer. No `as any` casts anywhere in new code.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/crypto-test.mjs` → all five steps PASS

RETURN FOR REVIEW (paste all five):
1. The file tree of apps/mobile/lib/crypto and apps/mobile/test
2. The FULL text of apps/mobile/lib/crypto/keys.ts
3. The FULL output of the crypto test
4. The terminal output of acceptance commands 1–3
5. Confirmation of the three drive-by fixes (paste the changed lines)
