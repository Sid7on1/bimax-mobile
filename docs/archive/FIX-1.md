# Bimax Mobile — Fix #1: pairing robustness (from the integration review)

Copy everything below the line into Antigravity as one prompt.

---

You are applying two small robustness fixes from the architecture integration review. No new features, no new dependencies, no other changes.

FIX 1 — `apps/mobile/lib/session/session.ts`: `handleGrant` must fail closed.
Problem: if `readMessage2` throws (tampered grant), the dead initiator stays in `pending` — its Noise state is corrupted so a retry on the same manager can never succeed, and `beginPairing` refuses to start over while the entry exists.
In `handleGrant`, change EXACTLY this:
OLD:
```ts
    const msg2 = base64ToBytes(grant.handshakeMessage);
    initiator.readMessage2(msg2);
```
NEW:
```ts
    const msg2 = base64ToBytes(grant.handshakeMessage);
    try {
      initiator.readMessage2(msg2);
    } catch (err) {
      // The Noise state is corrupted after a failed read — this initiator can
      // never complete. Drop it so a fresh beginPairing can retry.
      this.pending.delete(env.from);
      throw err;
    }
```

FIX 2 — `apps/mobile/app/pair.tsx`: load the private key via static imports.
Problem: `startPairingFlow` calls `getOrCreateX25519Keypair()` (which returns only the public key) and then does a dynamic `await import("../lib/crypto/secure-store")` to load the private key. Replace with static imports and a single load path.
Change EXACTLY this import block:
OLD:
```ts
import {
  parseAdvertisement,
  getOrCreateDeviceId,
  getOrCreateX25519Keypair,
  base64ToBytes,
} from "../lib/crypto";
```
NEW:
```ts
import {
  parseAdvertisement,
  getOrCreateDeviceId,
  getOrCreateX25519Keypair,
  loadDeviceKey,
  BIMAX_X25519_PRIV,
  base64ToBytes,
  x25519GetPublicKey,
} from "../lib/crypto";
```
And change EXACTLY this block inside `startPairingFlow`:
OLD:
```ts
      const deviceId = await getOrCreateDeviceId();
      const staticKeypairInfo = await getOrCreateX25519Keypair();
      const staticKeypair = {
        publicKey: base64ToBytes(staticKeypairInfo.publicKeyBase64),
        privateKey: new Uint8Array(0), // not needed by initiator, loaded by crypto
      };

      // We need the raw private key for NoiseIKInitiator: load from secure-store
      // getOrCreateX25519Keypair stores bimax_x25519_priv
      const { loadDeviceKey, BIMAX_X25519_PRIV } = await import(
        "../lib/crypto/secure-store"
      );
      const privB64 = await loadDeviceKey(BIMAX_X25519_PRIV);
      if (!privB64) {
        throw new Error("Private key not found in secure storage");
      }
      staticKeypair.privateKey = base64ToBytes(privB64);
```
NEW:
```ts
      const deviceId = await getOrCreateDeviceId();
      await getOrCreateX25519Keypair(); // ensure the keypair exists
      const privB64 = await loadDeviceKey(BIMAX_X25519_PRIV);
      if (!privB64) {
        throw new Error("Private key not found in secure storage");
      }
      const privateKey = base64ToBytes(privB64);
      const staticKeypair = {
        publicKey: x25519GetPublicKey(privateKey),
        privateKey,
      };
```

TEST ADDITION — `apps/mobile/test/pairing-test.mjs`, STEP 2 (tampered grant):
after asserting that `handleGrant` throws on the tampered grant, add an assertion that the failed pairing was cleaned up:
```js
assert.strictEqual(
  phoneManager.hasPending("desktop-1"),
  false,
  "failed grant must clear the pending pairing",
);
```
(Use whatever variable name the test already uses for the phone-side PairingManager; the desktop device id in the test is "desktop-1". If the test uses a different name, adapt — the assertion is what matters.)

SCOPE — DO NOT DO: nothing beyond the two fixes and the one test assertion. No new dependencies, no UI changes, no protocol changes.

ACCEPTANCE (repo root, paste the FULL terminal output):
1. `npx tsc --noEmit` → zero errors
2. `npx eslint .` → zero errors
3. `node apps/mobile/test/pairing-test.mjs` → all five steps PASS (STEP 2 now includes the cleanup assertion)

RETURN FOR REVIEW (paste all three):
1. The changed hunks of session.ts and pair.tsx
2. The FULL output of the pairing test
3. The terminal output of acceptance commands 1–2
