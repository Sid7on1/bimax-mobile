# Bimax PQ pairing v2 (experimental)

Status: implemented behind the desktop `enablePqPairing` flag, disabled by default. This is a Bimax composition of standardized ML-KEM-768 and Noise IKpsk0, **not a standardized PQ Noise protocol or an externally audited construction**. Enable for development/interoperability trials. Production enablement requires independent cryptographic review and device-runtime measurements.

## Enable and validate

Use Node 24.15+ in the supported Node 24 line (`.nvmrc`). Build shared code before launching a desktop adapter:

```sh
npm ci
npm run build:core
npm run check
npm run benchmark:pairing -- 100
```

Pass `enablePqPairing: true` to `startResponder`, `new Responder`, or the desktop `PairingManager`. The phone implements both advertisement formats. Both relay deployments must include `pairing_prekey_request` and `pairing_prekey` routing support. Existing clients that cannot confirm transport keys require a coordinated update even when PQ is disabled. Envelope `v: 2`, proof `pairingVersion: 2`, and encrypted frame `fver: 2` are distinct from the optional `cryptoVersion: 2` PQ advertisement marker.

No credentials, remote deployment, or production feature flags are changed by this implementation.

## Frozen wire composition

The canonical QR advertisement includes exactly the following fields. JSON object keys are sorted recursively; whitespace is omitted; absent `lanRelayUrl` is omitted. Strings use JSON encoding and expiry is a safe integer in Unix milliseconds. Binary fields use padded, canonical standard Base64.

```ts
{
  app: "bimax",
  relayUrl: string,
  lanRelayUrl?: string,
  ref: string,
  desktopDeviceId: string,
  desktopPublicKey: string, // 32-byte X25519 public key
  cryptoVersion: 2,
  suite: "PQIK_MLKEM768_IKPSK0_25519_CHACHAPOLY_BLAKE2S",
  pqPrekeyId: string,
  pqPrekeyHash: string, // SHA-256 of the raw 1184-byte encapsulation key
  expiresAt: number
}
```

The QR contains the public-key commitment, not the ML-KEM key. Over its existing admitted WebSocket, the phone sends `pairing_prekey_request` with `{ref, pqPrekeyId}`. The desktop responds with `pairing_prekey` containing `{requestId, advertisement, publicKey}`. The phone treats this response as untrusted, correlates its sender/recipient/request ID, and verifies the raw key against the **scanned** commitment. Response advertisement fields cannot replace the scanned advertisement. Malformed responses are ignored until a valid response or the 10-second lookup deadline; there is no classical retry.

Encapsulation returns `ciphertext` (1088 bytes) and `sharedSecret` (32 bytes). Define these exact UTF-8 bytes:

```text
prologue = canonicalJson({
  domain: "bimax/pairing/pqik/v2",
  advertisement: canonical_advertisement_object,
  kemCiphertext: base64(ciphertext)
})
psk = HKDF-SHA256(
  ikm  = sharedSecret,
  salt = SHA256(prologue),
  info = UTF8("Noise_IKpsk0 pairing PSK"),
  L    = 32
)
```

Initialize `Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s` with that prologue and PSK. The PSK token runs `MixKeyAndHash` before the first `e`, and both ephemeral public keys also run `MixKey` as required in Noise PSK mode. M1 still contains the existing signed pairing proof. PQ outer framing omits `mobilePublicKey`; the responder obtains that static key only from authenticated Noise M1. Classical compatibility retains its legacy outer key field. `pairing_request.payload` additionally carries `cryptoVersion: 2`, `pqPrekeyId`, and `kemCiphertext`. Missing, partial, unknown, mismatched, or expired PQ fields fail closed. The responder reconstructs the prologue from its own stored advertisement and received KEM ciphertext.

M2's authenticated payload is canonical JSON:

```text
{
  confirmation: "bimax/session-confirm/v2",
  handshakeId: base64(SHA256(raw_noise_message_1)),
  nextPqPrekey: { advertisement, publicKey } // required for PQ, absent for classical
}
```

The grant envelope also carries `handshakeId` as an untrusted correlation hint. The phone filters obsolete grants before mutating Noise state and verifies the same value inside authenticated M2. Both fields are required for PQ; they are not algorithm negotiation.

This distributes the next one-time prekey over the newly authenticated encrypted channel, including a fresh prekey ID, ref, hash, and 24-hour expiry. The phone validates its identity and commitment and saves its compact advertisement/commitment with the trusted desktop record after the user accepts the verification code. The full public key stays in memory; after an app restart it is fetched again and checked against the persisted commitment, keeping the secure-storage record small. Automatic re-handshakes replace it with the next authenticated prekey. The relay never chooses the suite or the authenticated reconnect prekey.

The low-level Noise API still supports classical IK and its existing vector/wire format. Supplying a 32-byte `psk` explicitly selects IKpsk0; there is no automatic fallback after failure. The QR parser rejects partial PQ advertisements. A persisted PQ trust record rejects classical re-handshakes even if the feature flag is subsequently disabled.

## One-time state and retransmission

The desktop serializes pairing requests (at most 16 queued) and authenticates Noise M1, the signed proof, IDs, ref/expiry or existing trust before consuming a PQ prekey. Failed decapsulation-derived authentication or failed application authorization cannot burn the prekey. ML-KEM implicit rejection is not treated as authorization.

On authenticated acceptance, consumption and secret-buffer overwriting occur synchronously before asynchronous replay-cache persistence. The responder completes M2 once and caches the exact grant for the confirmation timeout. An identical M1 and routing/payload fingerprint returns the same M2; a distinct M1 cannot use the consumed prekey. Retry envelope ID/timestamp may vary, but authenticated payload and routing cannot. Only the current attempt can use its cached grant; replay never reactivates a prior session. The phone retries the same M1 rather than re-encapsulating during the retry window.

Prekeys live only in desktop memory. A restart destroys their availability; the user must scan a new QR rather than downgrade. Initial QR refs rotate every 20 seconds and expire after 60 seconds by default. Next-session prekeys expire after 24 hours. At most 16 outstanding keys are retained; replacement, expiry, consumption, revocation and shutdown erase owned secret buffers. These operations are best-effort JavaScript hygiene, not guaranteed erasure of JIT/GC/runtime copies. `destroy()` makes a Noise instance terminal.

The persisted replay cache remains applicable to classical handshakes. A desktop restart cannot reuse a PQ prekey because its secret is not persisted. The M2 cache is also memory-only; a lost M2 across desktop restart requires a fresh QR.

## Transport confirmation and lifecycle

After authenticating M2, the phone immediately sends the first transport record (nonce 0) in an ordinary `encrypted` envelope. Its plaintext is canonical JSON:

```text
{
  confirmation: "bimax/session-confirm/v2",
  handshakeHash: base64(final_noise_handshake_hash),
  bound: {id, from, to} // exactly the outer envelope routing fields
}
```

This record does not consume a SealedFrame sequence number. The next ordinary SealedFrame starts at seq 0 while its Noise nonce is 1. The desktop validates confirmation plaintext before committing receive nonce state, and exact retries are dropped without resetting application sequence state. Pending refreshes remain bound to the currently trusted keys and are invalidated on trust replacement.

The desktop verifies the confirmation before trusting a new candidate or swapping an existing active session. Responder-side encryption is blocked until confirmation succeeds. Human verification remains an independent authorization requirement for initial pairing and replacement.

Unconfirmed sessions expire after 30 seconds. The old responder session can remain active during re-handshake; it is destroyed when confirmed new keys replace it. Cryptographic failure destroys the active session; recovery performs a fresh handshake rather than restoring failed cipher state. The phone erases active keys after connectivity loss. No encrypted record is queued by either client for reuse with a subsequent session; durable logical requests are resealed with fresh keys.

Managed sessions have hard limits of 30 minutes, 1,048,576 total sent/received records, and 256 MiB total plaintext across both directions. Failed operations do not consume the record/byte budget. The mobile provider rotates at 25 minutes and checks hard limits every 30 seconds. Rotation uses fresh Noise ephemerals and, for PQ trust, the next one-time ML-KEM contributor. Background/sleep scheduling may delay soft rotation, but hard limits still reject further crypto operations. Local session/prekey lifetimes also use a monotonic clock so wall-clock rollback cannot extend them. Missing/expired reconnect material requires a fresh scan and is surfaced in the Remote screen.

The nonce header remains `u64le || ciphertext`, with nonce mapping `0x00000000 || u64le`. The AEAD authenticates nonce selection. Semantically meaningful routing fields and kind are inside authenticated SealedFrames. This change does not add redundant nonce AAD or reinterpret the existing format. Ordering is an intentional monotonic high-water policy: forward gaps are accepted; duplicates and late lower nonces are rejected. This supports skipped sends and one ordered WebSocket stream, not arbitrary multipath reordering.

The phone's X25519/Ed25519 authentication remains classical. This feature protects the recorded handshake and transport against harvest-now/decrypt-later attacks under the hybrid assumptions; it does not add post-quantum client credentials for a future online quantum impersonator.

Periodic PQ refresh does not promise Signal-style recovery against active endpoint/session compromise. An attacker controlling the current channel can interfere with next-prekey distribution. Live endpoint compromise remains outside protocol confidentiality guarantees.

## Evidence and remaining release gates

`npm run pq-test` checks selected NIST ACVP/FIPS 203 keygen, encapsulation, decapsulation and invalid-key fixtures; ML-KEM interoperability in both directions with Node/OpenSSL; and a fixed IKpsk0 transcript/transport fixture generated independently using Python `noiseprotocol==0.3.1` and `cryptography==50.0.2`. The reference generator is checked in with its provenance; it is not represented as an official Noise vector.

Adversarial tests cover QR/key substitution, expiry, downgrade/partial fields, invalid KEM sizes, invalid application proof without consumption, malformed M1, concurrent identical retry, alternate-M1 reuse, first-message confirmation, session budgets, nonce mutation/replay/gaps, prekey erasure, and fresh-PQ refresh. Integration tests exercise public prekey lookup, lost-M2 retry, confirmation, encrypted application data and refresh over the real local WebSocket relay. The platform suite verifies both new public message kinds in an admitted Cloudflare Durable Object runtime. Existing classical Noise vectors and application regressions remain in the main check.

`npm run benchmark:pairing -- 100 [output.json]` records local runtime metadata and p50/p95/p99 for keygen, KEM operations, all four Noise message methods and total local crypto. For mobile/browser measurement, import `benchmarkPqPairing` from `@bimax/core/crypto/benchmark` in the actual shipped runtime, after configuring its CSPRNG. The harness uses a 512-byte initiator payload and an empty responder payload; it excludes network/framing and the next-prekey payload. It does not substitute for pairing latency telemetry.

Before production: independently review the KEM-to-PSK composition, canonical bytes/domain separation, atomic consumption/retry state machine and mobile/native backend threat model; run iOS/Android/browser device measurements and an interoperability trial with the desktop adapter. The pure-JS backend does not claim constant-time execution. No native mobile KEM backend or ratchet is included. Do not describe this build as audited, FIPS-certified, or validated on physical devices.

Primary references: [Noise specification](https://noiseprotocol.org/noise.html), [FIPS 203](https://csrc.nist.gov/pubs/fips/203/final), [NIST ACVP fixtures](https://github.com/usnistgov/ACVP-Server/tree/master/gen-val/json-files), [Noble post-quantum](https://github.com/paulmillr/noble-post-quantum), and [independent Noise reference](https://github.com/plizonczyk/noiseprotocol).

A local development benchmark is recorded in [the Node 24/macOS arm64 receipt](../../artifacts/crypto/pq-pairing-node24-arm64-2026-10-20.json). It is not a physical-phone or browser measurement.

The [20 October 2026 internal security review](pq-security-review-2026-10-20.md) documents ten remediated findings, regression evidence and outstanding enablement gates. Experimental PQ builds preceding that review need a coordinated phone/desktop update; no silent classical fallback is supported.
