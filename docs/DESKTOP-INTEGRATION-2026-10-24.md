# Bimax Desktop integration — 24 October 2026

Local source/build/contract integration is verified against `/Users/vishsiddharth/Bimax`.
A physical phone has not been paired or qualified by this work. Existing local changes are preserved.

Use Node 24 (this repo requires >=24.15.0 and <25). On the current Mac:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
cd /Users/vishsiddharth/Desktop/bimax-mobile
npm run check
cd /Users/vishsiddharth/Bimax
npm --prefix app run check:mobile
npm --prefix app run build
```

Desktop's existing installed `desktop-responder` and `@bimax/protocol` file links both resolve here.
Its new `app/scripts/mobile.integration.mjs` verifies that both installed packages come from the
same checkout and agree on the protocol package version. `BIMAX_MOBILE_REPO`, when set, must match
those installed links; it does not replace them. Local absolute dependency paths still require
coordinated portable checkout/CI setup; no public package publishing or dependency upgrades occurred.

Desktop dev/build/distribution now compile this repo's core, relay and responder first, producing
matching JavaScript and declarations. Desktop `check:mobile` executes the actual fourteen responder
cases and validates schemaVersion=1, protocolVersion=2 and exact case IDs 1–14 in a structured
result. The original test assertions remain. Reporting occurs only after every case succeeds.
It then bundles the actual mobile approval signer together with the Desktop adapter/ThreadManager
fixture and runs the linked responder verification gate. It verifies two engines issuing request 1,
their independent signed Yes/No replies, immutable request ownership, rejected session/signature
tampering, acknowledged replay without duplicate execution, and actual ThreadManager Stop before a
late approved operation. These engines capture replies; they do not call a provider or perform
real application effects.

`ApprovalsGate.registerRequest` now stores a cloned frozen request, treats identical pending
registration as idempotent, and rejects a conflicting or consumed capability. Caller mutation cannot
retarget a stored request or change the bytes whose hash is verified. Desktop uses fresh request
capability tokens rather than per-engine numeric IDs and checks cancellation/expiry at dispatch.

Verification on this Mac: full `npm run check` passed (typecheck, lint, crypto/Noise, gateway/mobile,
LAN/cloud/adversarial, fourteen responder cases and actual platform-runtime cases). Desktop's
131 focused tests, seven assertion-caught faults, typechecks/builds and actual Electron probes pass.
The broad Desktop Jest attempt has unrelated module-resolution/architecture/Node-24 contract failures;
its final-source full-suite qualification remains open. See Bimax product-reset record 104 and its
raw evidence for exact outcomes, early tooling failures and preservation hashes.

The responder remains opt-in via `BIMAX_RESPONDER=1`, with native local consent, visible remote
indicator and local emergency Stop. This work does not enable it, change account/provider credentials,
replace identity storage, deploy relay/gateway, install a new Desktop bundle, or build signed devices.
Main pairing IPC exists, but the normal Desktop renderer still needs a complete pairing/settings/
account flow. Physical iOS/Android pairing, reconnect, biometrics, installed real-provider/tool
cancellation, unknown-effect recovery, coordinated deployment and release remain Target.

## Superseding phone-settings work — record 105

Desktop Settings → Phone connection now explicitly enables an app-owned LAN relay, shows QR/manual
pairing data, compares candidate codes, reports authenticated online state, persists encrypted
settings and supports Disable, Forget and an interrupting latched Stop. The environment-only/UI-gap
paragraph above describes record 104's historical state. Read
[the iPhone/Expo Go guide](PHONE-PAIRING-EXPO-GO.md) for current connection steps.

The shared Node relay implementation now lives in `packages/core/src/relay/node.ts`; hosted relay
re-exports it. Desktop uses a memory-only Node SQLite store, retaining the same signed hello, replay,
sender and outbox rules. Its admission token, room and resource limits are enforced at upgrade.
The responder integration runner now asks its child for an OS-assigned listening port over IPC,
avoiding fixed-port collisions when Desktop and mobile checks run concurrently. It waits for its
own child, rather than accepting an unrelated service's health response.

The previously failing Desktop ESM/FTS5/worker-memory/public-protocol/markup checks are repaired;
record 105 contains exact suite outcomes, retained failures and final build receipts. No account
credentials, deployed relay/gateway, biometric gate or pre-existing deletion was changed.
