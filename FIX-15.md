# Bimax Mobile — FIX-15: phone must reset E2E state on every new Noise session

Copy everything below the line into Antigravity as one prompt.

---

Background: `DESKTOP-RESPONDER-CONTRACT.md` §5 states the DECIDED rule — both
peers MUST reset E2E state (`newE2EState()`) on every newly established Noise
transport session. Fresh session keys ⇒ fresh replay space. The desktop
responder implements this (`E2ERegistry.resetPeer`). The phone does NOT:
`apps/mobile/lib/session/provider.tsx` keeps `e2eStateRef` (a
`Map<string, E2EState>` keyed by peer deviceId) and `getE2EState()` reuses the
existing entry across re-handshakes. Consequence: after a re-handshake the
desktop resets its counters to 0 while the phone keeps its old
`recvHighestSeq` — the desktop's fresh frames are then rejected by the phone
as replays (and vice versa), silently breaking the session until counters
happen to pass the old highs.

## The fix

In `apps/mobile/lib/session/provider.tsx`, in `handleIncoming`'s
`pairing_grant` branch, inside the `try` block immediately after
`const session = manager.handleGrant(grantEnv);` succeeds (i.e. exactly when
the new session is installed, before or after the `setSessions` call):

```ts
// Contract §5: fresh Noise session keys => fresh E2E replay space.
// Reset send/recv sequence state for this peer on EVERY new session.
e2eStateRef.current.set(peerId, newE2EState());
```

`newE2EState` is already imported in this file. Both user-initiated pairings
and automatic re-handshakes flow through this exact block, and BOTH must
reset — do not add any condition distinguishing them.

Do NOT touch `getE2EState`, the `seal`/`open` call sites, or anything else in
the file.

## Why this is safe (sanity check for the reviewer)

- Within a session, `open()` still rejects `seq <= recvHighestSeq` and
  duplicate outer ids — per-session replay protection is unchanged.
- The old session's keys are discarded with the old session object; frames
  sealed under old keys fail decryption on the new session regardless.

## SCOPE — DO NOT DO

- Only `apps/mobile/lib/session/provider.tsx`. No protocol changes, no other
  files, no `~/Bimax`.

## ACCEPTANCE (paste the FULL terminal output)

1. `npx tsc --noEmit` (from repo root) → zero errors
2. `npx eslint apps/mobile/lib/session/provider.tsx` (from repo root) → zero errors
3. `node apps/mobile/test/pairing-test.mjs` → all steps PASS (regression:
   pairing + re-handshake flows still work)

## RETURN FOR REVIEW (paste all three)

1. The changed hunk (before/after).
2. The FULL terminal output of acceptance commands 1–3.
3. One paragraph explaining why this single change covers both user-initiated
   pairing and automatic re-handshake.
