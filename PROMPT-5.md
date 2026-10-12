# Bimax Mobile — Prompt #5: Noise_IK handshake

Copy everything below the line into Antigravity as one prompt.

---

You are implementing the Noise_IK handshake for Bimax mobile. Context: companion remote; Prompts #1–4 built the scaffold, relay server, relay client, and tested crypto primitives (X25519, Ed25519, HKDF-SHA256, ChaCha20-Poly1305, canonical JSON, secure storage, pairing message builders). Now the two sides need to turn the QR-scanned advertisement into an authenticated, forward-secret encrypted channel. This is the single trickiest piece of code in the project — implement the algorithm below EXACTLY. Do not simplify, do not improvise, do not invent your own key schedule.

SPEC: Noise_IK_25519_ChaChaPoly_BLAKE2s, Noise Protocol Framework revision 34. CipherSuite: DH = X25519, Cipher = ChaChaPoly, Hash = BLAKE2s. Protocol name (34 bytes): the ASCII string `Noise_IK_25519_ChaChaPoly_BLAKE2s`.

STACK (exact): TypeScript strict, ZERO new dependencies. BLAKE2s comes from the already-installed `@noble/hashes` (`import { blake2s } from "@noble/hashes/blake2.js"`). Reuse `KeyPair` and the ECDH/AEAD helpers from `../keys` (keys.ts) where they fit; the Noise state machine itself you write by hand per the algorithm below. No Buffer, no `as any`.

ALGORITHM — implement exactly these pieces:

1. Constants: HASHLEN = 32. Protocol name P = ASCII `Noise_IK_25519_ChaChaPoly_BLAKE2s` (34 bytes, LONGER than HASHLEN — this matters in step 3).
2. `nonce12(n: number): Uint8Array` — 12-byte Noise nonce: 4 zero bytes followed by n as 64-bit little-endian. n starts at 0.
3. `InitializeSymmetric()`: because P is 34 bytes (> HASHLEN 32), set `h = BLAKE2s(P)` and `ck = h`. (If it had been ≤ 32 bytes you would zero-pad — it is not, so hash it.)
4. `MixHash(data)`: `h = BLAKE2s(h || data)`.
5. `MixKey(input)`: `(ck, temp_k) = HKDF(ck, input, 2)` (HKDF defined in step 9); keep the SECOND output as temp_k; then `InitializeKey(temp_k)`: set cipher key k = temp_k, nonce n = 0.
6. `EncryptAndHash(plaintext)`: `ct = ChaChaPoly-encrypt(key=k, nonce=nonce12(n), aad=h, plaintext)`; then `n = n + 1`; then `MixHash(ct)`; return ct.
7. `DecryptAndHash(ciphertext)`: `pt = ChaChaPoly-decrypt(key=k, nonce=nonce12(n), aad=h, ciphertext)` — throws on auth failure; then `n = n + 1`; then `MixHash(ciphertext)`; return pt. (On auth failure throw before touching n or h.)
8. `Split()`: `(temp_k1, temp_k2) = HKDF(ck, empty, 2)`; return two cipher states: c1 = (k=temp_k1, n=0), c2 = (k=temp_k2, n=0). After Split, the handshake's ck/h are discarded (keep h for getHandshakeHash).
9. `HKDF(chaining_key, input_key_material, num_outputs)` per the Noise spec with HASH=BLAKE2s:
   - output1 = HMAC-BLAKE2s(key=chaining_key, data=input_key_material || 0x01)
   - output2 = HMAC-BLAKE2s(key=chaining_key, data=output1 || input_key_material || 0x02)
   - (output3 likewise with 0x03 if needed)
   - return the first num_outputs outputs. (You need HMAC-BLAKE2s — implement it directly: ipad/opad over the 64-byte BLAKE2s block size. Do NOT substitute HKDF-SHA256 from keys.ts — the hash must be BLAKE2s.)
10. `DH(priv, pub)` = X25519 ECDH (reuse `x25519SharedSecret` from keys.ts).

HANDSHAKE — IK pattern. Initiator = phone (knows responder's static public key from the QR advertisement). Responder = desktop.

Initiator (`NoiseIKInitiator`):
- Constructor takes `{ staticKeypair: KeyPair, remoteStaticPublicKey: Uint8Array }` plus an OPTIONAL test-only `{ ephemeralKeypair?: KeyPair }` (documented as test-only; production passes nothing and you generate one).
- `writeMessage1(payload: Uint8Array): Uint8Array`:
  - InitializeSymmetric(); MixHash(remoteStaticPublicKey).
  - Generate ephemeral e (or use the injected one). Token `e`: MixHash(e.publicKey); message = e.publicKey.
  - Token `es`: MixKey(DH(e.privateKey, remoteStaticPublicKey)).
  - Token `s`: message += EncryptAndHash(staticKeypair.publicKey).
  - Token `ss`: MixKey(DH(staticKeypair.privateKey, remoteStaticPublicKey)).
  - Payload: message += EncryptAndHash(payload). Return message.
  - Layout: 32 bytes e_pub || 48 bytes enc(static pub) || (payload.length + 16) bytes enc(payload).
- `readMessage2(message: Uint8Array): Uint8Array`:
  - Split the first 32 bytes as e_r_pub; MixHash(e_r_pub).
  - Token `ee`: MixKey(DH(e.privateKey, e_r_pub)).
  - Token `se`: MixKey(DH(staticKeypair.privateKey, e_r_pub)).
  - Remaining bytes: DecryptAndHash → return payload2 (throws on failure).
  - Then Split() → store transport keys. Mark handshake complete; any further writeMessage1/readMessage2 call throws.
- After completion: `encrypt(plaintext)` encrypts with c1 (initiator→responder), `decrypt(ciphertext)` decrypts with c2; nonces increment per message and MUST never reuse — throw if n would exceed 2^64 - 1.
- `getHandshakeHash(): Uint8Array` returns the final h (identical on both sides; future safety-number UI).

Responder (`NoiseIKResponder`):
- Constructor takes `{ staticKeypair: KeyPair }` plus optional test-only `{ ephemeralKeypair?: KeyPair }`.
- `readMessage1(message: Uint8Array): { payload: Uint8Array; remoteStaticPublicKey: Uint8Array }`:
  - InitializeSymmetric(); MixHash(staticKeypair.publicKey) (its OWN static pub — the pre-message).
  - e_i_pub = first 32 bytes; MixHash(e_i_pub).
  - Token `es`: MixKey(DH(staticKeypair.privateKey, e_i_pub)); next 48 bytes → DecryptAndHash → initiator static pub S_i.
  - Token `ss`: MixKey(DH(staticKeypair.privateKey, S_i)); remaining bytes → DecryptAndHash → payload1.
  - Return { payload: payload1, remoteStaticPublicKey: S_i }. Then it may call writeMessage2.
- `writeMessage2(payload: Uint8Array): Uint8Array`:
  - Generate ephemeral e_r (or injected). Token `e`: MixHash(e_r.publicKey); message = e_r.publicKey.
  - Token `ee`: MixKey(DH(e_r.privateKey, e_i_pub)) — e_i_pub saved from readMessage1.
  - Token `se`: MixKey(DH(e_r.privateKey, S_i)).
  - Payload: message += EncryptAndHash(payload). Then Split() → store transport keys. Layout: 32 || (payload.length + 16).
- After completion: `encrypt` uses c2 (responder→initiator), `decrypt` uses c1; same nonce discipline.
- `getHandshakeHash()` as above.

TASK:
1. Create `apps/mobile/lib/crypto/noise.ts` implementing exactly the above. Export `NoiseIKInitiator`, `NoiseIKResponder`. Add `export * from "./noise";` to `apps/mobile/lib/crypto/index.ts`.
2. TEST — `apps/mobile/test/noise-test.mjs` (plain Node):
   - At start, compile with tsc (same flags as the crypto test: `--module commonjs --target es2022 --moduleResolution node --strict --esModuleInterop --skipLibCheck`) the files `noise.ts`, `keys.ts`, `base64.ts` into a tmpdir and require them.
   - STEP 1 (full handshake): generate static keypairs for initiator and responder; initiator.writeMessage1(ref-bytes) → responder.readMessage1 → responder.writeMessage2(grant-bytes) → initiator.readMessage2. Assert: payloads round-trip exactly; `getHandshakeHash()` equal on both sides (32 bytes). Then transport: initiator.encrypt → responder.decrypt (and reverse), 3 messages each direction. PASS/FAIL.
   - STEP 2 (tamper): flip one byte in message1 → assert responder.readMessage1 THROWS. Flip one byte in message2 → assert initiator.readMessage2 THROWS. PASS/FAIL.
   - STEP 3 (wrong peer): run the handshake with the initiator configured with a DIFFERENT remoteStaticPublicKey than the responder's real one → assert readMessage1 or readMessage2 THROWS (authentication fails). PASS/FAIL.
   - STEP 4 (known-answer): download the official test vector file `https://raw.githubusercontent.com/rweather/noise-c/master/tests/vectors/noise-c-basic.txt`, find the `Noise_IK_25519_ChaChaPoly_BLAKE2s` section, and embed its fixed keys and expected values as constants in the test. Drive your implementation with the vector's fixed static AND ephemeral keys (via the test-only constructor parameter) and assert byte-equality of the handshake messages and handshake hash. If the file cannot be fetched or has no IK section, print `STEP 4 (known-answer): SKIP (no vector available)` and continue — do not fail the run for this reason alone.
   - STEP 5 (transport nonce discipline): after a good handshake, encrypt one message, decrypt it, then attempt to decrypt the SAME ciphertext bytes again → assert it THROWS (nonce already advanced). PASS/FAIL.
   - Print PASS/FAIL (or SKIP) per step, delete tmpdir, exit 0 iff no step FAILED.

SCOPE — DO NOT DO:
- No QR scanner UI, no pairing screens (next prompt). No changes to relay, protocol, relay client, or the existing crypto files except the one-line index.ts barrel addition.
- No new dependencies. No Buffer. No `as any`. No test hooks beyond the documented optional ephemeralKeypair constructor parameter.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `node apps/mobile/test/noise-test.mjs` → no FAILED steps

RETURN FOR REVIEW (paste all four):
1. The file tree of apps/mobile/lib/crypto and apps/mobile/test
2. The FULL text of apps/mobile/lib/crypto/noise.ts
3. The FULL output of the noise test
4. The terminal output of acceptance commands 1–3
