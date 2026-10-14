# Bimax Mobile — Fix #3b: refresh trustedDesktop after fresh pairing

Copy everything below the line into Antigravity as one prompt.

---

Follow-up to Fix #3. Background: Fix #3 exposed `trustedDesktop` in the provider context, but it is only set in the init effect. After a fresh pairing, `pair.tsx` saves via `saveTrustedDesktop()` directly without notifying the provider — so `trustedDesktop` stays `null` until app restart, and the home screen wrongly shows the "No Paired Desktop" card despite an active session. (Before Fix #3 the card logic checked `sessions.length`, which hid it correctly after pairing.)

## Change 1 — `apps/mobile/lib/session/provider.tsx`: add refreshTrustedDesktop

(a) In `RelayContextValue`, after the `trustedDesktop` line:
OLD:
```ts
  trustedDesktop: TrustedDesktop | null;
```
NEW:
```ts
  trustedDesktop: TrustedDesktop | null;
  refreshTrustedDesktop: () => Promise<void>;
```

(b) Add the callback (place it near the other trusted-desktop logic):
```ts
  const refreshTrustedDesktop = useCallback(async (): Promise<void> => {
    const trusted = await loadTrustedDesktop();
    trustedRef.current = trusted;
    setTrustedDesktop(trusted);
  }, []);
```

(c) In the context value, after the `trustedDesktop,` entry, add:
```ts
    refreshTrustedDesktop,
```

## Change 2 — `apps/mobile/app/pair.tsx`: notify the provider after saving

Add `refreshTrustedDesktop` to the existing `useRelayContext()` destructuring, then in the "Codes match — Done" handler:

OLD:
```tsx
                try {
                  await saveTrustedDesktop({
                    deviceId: advert.desktopDeviceId,
                    staticPublicKeyB64: advert.desktopPublicKey,
                    relayUrl: advert.relayUrl,
                    lanRelayUrl: advert.lanRelayUrl,
                  });
                } catch (err) {
                  // Never report success without a saved record.
                  setErrorMessage(
                    err instanceof Error ? err.message : "Could not save trusted desktop",
                  );
                  setStep("error");
                  return;
                }
```
NEW:
```tsx
                try {
                  await saveTrustedDesktop({
                    deviceId: advert.desktopDeviceId,
                    staticPublicKeyB64: advert.desktopPublicKey,
                    relayUrl: advert.relayUrl,
                    lanRelayUrl: advert.lanRelayUrl,
                  });
                } catch (err) {
                  // Never report success without a saved record.
                  setErrorMessage(
                    err instanceof Error ? err.message : "Could not save trusted desktop",
                  );
                  setStep("error");
                  return;
                }
                try {
                  await refreshTrustedDesktop();
                } catch {
                  // Ignore: the record is saved, so pairing succeeded. Worst
                  // case the home card corrects itself on next launch.
                }
```

## SCOPE — DO NOT DO

Nothing beyond the two changes. No protocol changes, no UI redesign.

## ACCEPTANCE (repo root, paste the FULL terminal output)

1. `npx tsc --noEmit` → zero errors
2. `npx eslint .` → zero errors
3. `node apps/mobile/test/approvals-test.mjs` → all steps PASS (regression)

## RETURN FOR REVIEW

1. Confirmation of both changes (file + what was done)
2. The FULL terminal output of acceptance commands 1–3
