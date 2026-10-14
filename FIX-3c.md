# Bimax Mobile — Fix #3c: pairing-layer cleanup (trust timing, dead ref, hung promise)

Copy everything below the line into Antigravity as one prompt.

---

Background: Fix #3 was run twice (the superseded first version, then the corrected file), which layered two overlapping mechanisms in `apps/mobile/lib/session/provider.tsx`. The code works, but review found four real problems:

1. **Trust set before verification:** the grant-resolve wrapper in `pairWithDesktop` sets `trustedRef`/`trustedDesktop` the moment the grant arrives — BEFORE the user confirms the verification codes. If the user taps "Doesn't match", the provider still treats the peer as trusted for the rest of the session (and the E2E session itself is never torn down).
2. **Vestigial ref:** `pairingManagerRef` is now dead weight — init sets it, but the grant handler reads `rehandshakePairingRef`, and the real abandonment happens via the `rehandshakePairingRef → abandonedManagersRef` block. Fix #3's Change-7 block checks `pairingManagerRef`, which is redundant with the block right below it.
3. **Hung promise:** when a second user pairing supersedes a first, the old promise is never settled (timer cleared, entry deleted, no reject).
4. **Unbounded `abandonedManagersRef`:** entries whose grants never arrive stay forever.

Do NOT touch the attemptId machinery, the grant handler's routing, or the abandoned-managers absorb loop — they are correct as-is.

## Change 1 — `apps/mobile/lib/session/provider.tsx`: trusted state only after code verification

The resolve wrapper must not set trust; `refreshTrustedDesktop()` (called by `pair.tsx` after the user confirms the codes and the record is saved) is the single place trust is established.

OLD:
```ts
        userPairingsRef.current.set(advert.desktopDeviceId, {
          manager,
          resolve: (session) => {
            const trustedRecord: TrustedDesktop = {
              deviceId: advert.desktopDeviceId,
              staticPublicKeyB64: advert.desktopPublicKey,
              relayUrl: advert.relayUrl,
              lanRelayUrl: advert.lanRelayUrl,
            };
            trustedRef.current = trustedRecord;
            setTrustedDesktop(trustedRecord);
            resolve(session);
          },
          reject,
          timer,
          attemptId,
        });
```
NEW:
```ts
        // NOTE: trust is established only after the user confirms the
        // verification codes — pair.tsx calls refreshTrustedDesktop()
        // after saveTrustedDesktop(). Never set trusted state here.
        userPairingsRef.current.set(advert.desktopDeviceId, {
          manager,
          resolve,
          reject,
          timer,
          attemptId,
        });
```

## Change 2 — tear down the session on code mismatch

Add a `dropSession` method and call it from the "Doesn't match" path — a peer that failed verification must not keep an E2E session.

(a) In `RelayContextValue`, after the `getSession` line:
OLD:
```ts
  getSession: (peerId: string) => EstablishedSession | undefined;
```
NEW:
```ts
  getSession: (peerId: string) => EstablishedSession | undefined;
  dropSession: (peerDeviceId: string) => void;
```

(b) Next to `getSession`, add:
```ts
  const dropSession = useCallback((peerDeviceId: string): void => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.peerDeviceId !== peerDeviceId);
      sessionsRef.current = next;
      return next;
    });
  }, []);
```

(c) In the context value, after the `getSession,` entry, add `dropSession,`.

(d) In `apps/mobile/app/pair.tsx`: add `dropSession` to the `useRelayContext()` destructuring, then in the "Doesn't match" `onPress`:
OLD:
```tsx
            onPress={() => {
              setErrorMessage(
                "Verification code mismatch! The connection may be intercepted. Please rescan.",
              );
              setStep("error");
            }}
```
NEW:
```tsx
            onPress={() => {
              // Tear down the session: this peer was never verified.
              if (advert) {
                dropSession(advert.desktopDeviceId);
              }
              setErrorMessage(
                "Verification code mismatch! The connection may be intercepted. Please rescan.",
              );
              setStep("error");
            }}
```

## Change 3 — `apps/mobile/lib/session/provider.tsx`: remove the vestigial pairingManagerRef

The re-handshake is fully managed through `rehandshakePairingRef` now (init assignment, grant routing, abandonment). Delete:
(a) the declaration `const pairingManagerRef = useRef<PairingManager | null>(null);`
(b) the init assignment `pairingManagerRef.current = pairingManager;`
(c) the entire Fix-#3 Change-7 block (the precedence comment + `if (pairingManagerRef.current?.hasPendingPairing(...))` block) in `pairWithDesktop` — the `rehandshakePairingRef → abandonedManagersRef` block immediately below it already performs the abandonment. Move the desktop-contract comment onto that block:
```ts
      // Precedence rule: user-initiated pairing wins.
      // (Desktop contract: a desktop MUST only grant the most recent
      // pairing_request per mobile deviceId; earlier ones are superseded.)
      if (
        rehandshakePairingRef.current &&
        rehandshakePairingRef.current.manager.hasPendingPairing(advert.desktopDeviceId)
      ) {
        abandonedManagersRef.current.push(rehandshakePairingRef.current.manager);
        rehandshakePairingRef.current = null;
      }
```
(d) any other reference (e.g. unmount cleanup). Verify with grep that zero `pairingManagerRef` remain.

## Change 4 — `apps/mobile/lib/session/provider.tsx`: settle superseded pairings, bound the abandoned list

In `pairWithDesktop`'s existing-user abandonment block:

OLD:
```ts
      // If a previous user pairing is in flight for this desktop, abandon it as well
      const existingUser = userPairingsRef.current.get(advert.desktopDeviceId);
      if (existingUser) {
        clearTimeout(existingUser.timer);
        abandonedManagersRef.current.push(existingUser.manager);
        userPairingsRef.current.delete(advert.desktopDeviceId);
      }
```
NEW:
```ts
      // If a previous user pairing is in flight for this desktop, abandon it as well
      const existingUser = userPairingsRef.current.get(advert.desktopDeviceId);
      if (existingUser) {
        clearTimeout(existingUser.timer);
        existingUser.reject(new Error("Superseded by a newer pairing attempt"));
        abandonedManagersRef.current.push(existingUser.manager);
        // Bound the abandoned list; entries whose grants never arrive are dropped.
        while (abandonedManagersRef.current.length > 10) {
          abandonedManagersRef.current.shift();
        }
        userPairingsRef.current.delete(advert.desktopDeviceId);
      }
```

## SCOPE — DO NOT DO

Nothing beyond the four changes. Do not touch the attemptId/counter machinery, the grant handler's routing logic, or the abandoned-managers absorb loop. No protocol changes, no UI redesign.

## ACCEPTANCE (repo root, paste the FULL terminal output)

1. `npx tsc --noEmit` → zero errors
2. `npx eslint .` → zero errors
3. `node apps/mobile/test/approvals-test.mjs` → all steps PASS (regression)
4. `grep -n "pairingManagerRef" apps/mobile/lib/session/provider.tsx` → no hits

## RETURN FOR REVIEW (paste both)

1. Confirmation of each of the 4 changes (file + what was done)
2. The FULL terminal output of acceptance commands 1–4
