# Bimax Mobile — FIX-14: five must-fix items in the desktop responder

Copy everything below the line into Antigravity as one prompt.

---

Background: PROMPT-14 implemented `apps/desktop-responder/` per
`DESKTOP-RESPONDER-CONTRACT.md`. Deep review of all 12 source files found five
must-fix items. Fix exactly these five. Do not redesign anything else.

## FIX-1 (functional break): the responder never learns the phone's hello pubkey, so the approval gate is dead in production

Root cause: the phone's `pairing_request` payload is
`{ ref, mobileDeviceId, mobilePublicKey, handshakeMessage }` — there is NO
`helloPubkey` field (see `apps/mobile/lib/session/session.ts` `beginPairing`).
`src/pairing.ts` reads `payload["helloPubkey"]`, which is always `undefined`,
so `confirmPairing(code)` throws "Missing phone hello pubkey" unless the caller
passes it explicitly. The integration test passes it explicitly, which is why
the suite is green — but a real phone pairing leaves the trust record without
`phoneHelloPubkeyB64`, and `ApprovalsGate` then rejects EVERY decision with
`approval_no_pinned_pubkey`. Approvals can never work after a real pairing.

Fix (no phone change needed — capture it from the signed hellos, which the
relay signature-verifies and TOFU-pins per deviceId per protocol v1.5):

1. In `src/pairing.ts`, add:
   ```ts
   private observedHelloPubkeys = new Map<string, string>();

   /** Records a helloPubkey observed on a relay-verified signed hello. */
   public noteHelloPubkey(deviceId: string, helloPubkeyB64: string): void {
     if (typeof deviceId !== "string" || !deviceId) return;
     if (typeof helloPubkeyB64 !== "string" || !helloPubkeyB64) return;
     this.observedHelloPubkeys.set(deviceId, helloPubkeyB64);
   }
   ```
2. In `confirmPairing` and `confirmReplaceTrustedPhone`, resolve the hello
   pubkey in this order: explicit param → `candidatePairing.phoneHelloPubkeyB64`
   → `this.observedHelloPubkeys.get(candidatePairing.phoneDeviceId)` → throw
   "Missing phone hello pubkey for trust record".
3. In `src/responder.ts` `handleRelayMessage`, add BEFORE the
   `pairing_request` branch:
   ```ts
   if (env.kind === "hello") {
     const payload = env.payload as { helloPubkey?: unknown };
     if (payload && typeof payload.helloPubkey === "string") {
       this.pairingManager.noteHelloPubkey(env.from, payload.helloPubkey);
     }
     return;
   }
   ```

## FIX-2: failed commands/kills are not idempotent — redelivery re-executes

Root cause: `IdempotencyLog.execute()` DELETES the entry when `fn()` throws,
and `dispatchInnerFrame`'s `command_request`/`kill_request` handlers let engine
errors propagate out of `fn`. So if the engine executes a side effect and then
throws (or the result is lost), a same-key redelivery re-executes — the exact
duplicate execution the log exists to prevent. (`chat.ts` already does it
right: it catches inside `fn` and returns an `ok:false` result, which IS
recorded.) Contract §8 requires recording failed state too.

Fix: add an `onError` mapper to `IdempotencyLog.execute`:

```ts
public async execute<T>(
  key: string,
  fn: () => Promise<T>,
  onError?: (err: unknown) => T,
): Promise<{ result: T; wasDuplicate: boolean }>
```

On `fn()` throwing: if `onError` is provided, compute `result = onError(err)`,
store `{ status: "done", result, at: Date.now() }` (LRU-refresh + persist like
the success path), resolve in-flight waiters with it, and return
`{ result, wasDuplicate: false }`. If `onError` is absent, keep the current
behavior (delete + rethrow).

Then in `src/responder.ts`:
- `command_request`: pass `onError: (err) => ({ idempotencyKey: req.idempotencyKey, ok: false, summary: err instanceof Error ? err.message : "Engine error" })` and REMOVE the outer try/catch (the failure result now flows through `sendEncrypted("command_result", cmdRes)`).
- `kill_request`: pass `onError: (err) => ({ idempotencyKey: req.idempotencyKey, ok: false, detail: "Failed to abort task", at: Date.now() })` and likewise remove the outer try/catch. Keep the `cancelForSession()` call where it is.

## FIX-3: no bound on concurrent file transfers (contract §10 requires it)

Root cause: `FilePipeline` has no cap on `activeTransfers` — a peer can open
unbounded 25 MB transfers and exhaust RAM.

Fix: in `src/files.ts`, add `const MAX_CONCURRENT_TRANSFERS = 4;` and in
`handleOffer`, after `this.sweepExpired(now)`:
```ts
if (this.activeTransfers.size >= MAX_CONCURRENT_TRANSFERS) {
  return { reject: { transferId, reason: "Too many concurrent transfers" } };
}
```

## FIX-4: `confirmReplaceTrustedPhone` skips the verification-code check

Root cause: `confirmPairing` verifies the human-compared code, but
`confirmReplaceTrustedPhone` does not take or check a code — re-pairing to an
attacker's device would need only a live QR ref, defeating the code as the
human firewall.

Fix: change the signature to
`confirmReplaceTrustedPhone(code: string, phoneHelloPubkeyB64?: string)` and
as the first statement:
```ts
if (!this.candidatePairing || this.candidatePairing.verificationCode !== code) {
  throw new Error("Verification code does not match");
}
```

## FIX-5: stale E2E state when trust is (re-)established — fresh frames rejected as replays

Root cause: `confirmPairing` installs a new Noise session but never resets the
peer's E2E state. If the same phone pairs, is revoked, and pairs again, the
responder reuses the old `E2EState` (high `recvHighestSeq`) while the phone
starts its counters at 0 — the phone's fresh frames are rejected as replays.

Fix: in `src/responder.ts`, add the single entry point the future adapter must
use for trust establishment:
```ts
/**
 * Confirms a candidate pairing after human verification-code comparison.
 * Resets E2E state for the peer (contract §5: fresh session keys => fresh
 * replay space). The future ~/Bimax adapter MUST call this — not
 * pairingManager.confirmPairing directly.
 */
public async confirmTrustedPhone(
  code: string,
  phoneHelloPubkeyB64?: string,
): Promise<TrustedPhoneRecord> {
  const record = await this.pairingManager.confirmPairing(code, phoneHelloPubkeyB64);
  this.e2e.resetPeer(record.phoneDeviceId);
  return record;
}
```
Import the `TrustedPhoneRecord` type from `./pairing`. Update the
`confirmPairing` doc comment in `pairing.ts` to point at
`Responder.confirmTrustedPhone`.

## SCOPE — DO NOT DO

- Only `apps/desktop-responder/` and its test. No changes to `apps/mobile`,
  `apps/relay`, `apps/cloud-relay`, `packages/protocol`, or `~/Bimax`.
- No protocol changes. No new dependencies. No `as any`, no Buffer.

## ACCEPTANCE (paste the FULL terminal output)

1. `cd apps/desktop-responder && npx tsc --noEmit` → zero errors
2. `npx eslint apps/desktop-responder` (from repo root) → zero errors
3. `node apps/desktop-responder/test/integration-test.mjs` → all cases PASS,
   including THREE new cases:
   - **CASE 10 (hello-capture):** fresh pairing where the test calls
     `responder.confirmTrustedPhone(code)` with NO explicit hello pubkey
     (relying on FIX-1's hello capture), then FakeEngine emits an approval,
     the phone approves, and `resolveApproval("approved")` is observed.
   - **CASE 11 (failure idempotency):** FakeEngine gets a scripted
     command-failure mode; send `command_request` with key K (engine fails),
     redeliver K → FakeEngine execution counter stays 1 and the phone gets
     `command_result{ok:false}` (proves FIX-2).
   - **CASE 12 (transfer cap):** open 5 concurrent file offers → the 5th gets
     `file_reject` (proves FIX-3).

## RETURN FOR REVIEW (paste all three)

1. The complete diff-style listing of every changed hunk (file + function +
   before/after) for FIX-1 through FIX-5.
2. The FULL terminal output of acceptance commands 1–3.
3. Explicit confirmation of each SCOPE item.
