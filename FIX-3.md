# Bimax Mobile — Fix #3: audit fixes (approval await, grant race, pair card, dead code)

Copy everything below the line into Antigravity as one prompt.

---

You are fixing real bugs from the 2026-10-13 full-tree audit of this repo. Background, per bug:

- **Approval unhandled rejection (A1):** `decideWithBiometric` calls the provider's async `onDecision` without awaiting it (typed `void`). When `sendEncrypted` throws (no client/session), the rejection is unhandled and silent.
- **Pair card lies (D1):** the home screen shows "No Paired Desktop / Pair a Desktop" whenever the relay is unreachable — even with a trusted desktop configured — inviting pointless re-pairing.
- **Grant routing race (A2):** if the user starts pairing while the app-start re-handshake is still in flight for the same desktop, the arriving `pairing_grant` can be fed to the wrong `NoiseIKInitiator` (the grant router prefers the user-pairing manager), killing both attempts with no retry.
- **Swallowed save (B1):** `pair.tsx` catches `saveTrustedDesktop()` failure and shows pairing success anyway.
- **Phantom online (F1):** if the hello signer throws, `client.ts` returns after `setStatus("online")`, leaving a hello-less socket marked online.
- **Ship-blocker:** `expo-camera` is missing from `app.json` plugins, so the QR scanner gets no permission declarations in standalone builds.
- **Dead code:** `useRelay.ts` (would send unsigned hellos if revived), the presence map (keyed wrong, never read), and raw `send()` on the context (bypasses E2E, unused).

No protocol changes. No new dependencies.

## Change 1 — `apps/mobile/app.json`: register the expo-camera plugin

Without this, standalone builds get no camera permission declarations and the QR scanner — the primary pairing path — is dead in the production APK.

OLD:
```json
    "plugins": [
      "expo-router",
      "expo-secure-store"
    ]
```
NEW:
```json
    "plugins": [
      "expo-router",
      "expo-secure-store",
      "expo-camera"
    ]
```

## Change 2 — `apps/mobile/lib/approvals/approvals.ts`: await onDecision

The provider passes an async `onDecision`; the helper must await it so send failures propagate instead of becoming unhandled rejections.

OLD:
```ts
  onDecision: (dec: ApprovalDecision) => void;
```
NEW:
```ts
  onDecision: (dec: ApprovalDecision) => Promise<void>;
```

OLD:
```ts
  const unsigned = opts.build();
  const signed = opts.sign(unsigned);
  opts.onDecision(signed);
}
```
NEW:
```ts
  const unsigned = opts.build();
  const signed = opts.sign(unsigned);
  await opts.onDecision(signed);
}
```

## Change 3 — `apps/mobile/lib/session/provider.tsx`: approval stays pending if the send fails

The current `onDecision` already sends before removing — add the comment so the ordering stays load-bearing now that Change 2 makes the throw propagate (the approval must NOT be removed when the send fails, so the user can retry).

OLD:
```ts
        onDecision: async (dec) => {
          const privKey = await getEd25519PrivateKey();
          const { signature: _sig, ...unsigned } = dec;
          const signed = signApprovalDecision(unsigned, privKey);
          sendEncrypted(desktopId, "approval_decision", signed);
          removeApproval(approvalId);
          setPendingApprovals(getPending());
        },
```
NEW:
```ts
        onDecision: async (dec) => {
          const privKey = await getEd25519PrivateKey();
          const { signature: _sig, ...unsigned } = dec;
          const signed = signApprovalDecision(unsigned, privKey);
          // ORDER MATTERS: send first. decideWithBiometric now awaits this
          // callback, so if the send throws, the error propagates and the
          // approval stays pending for retry (it is NOT removed below).
          sendEncrypted(desktopId, "approval_decision", signed);
          removeApproval(approvalId);
          setPendingApprovals(getPending());
        },
```

## Change 4 — `apps/mobile/app/approvals.tsx`: show the real error

Approve failures all collapse to generic `"Authentication failed"`, hiding the actual cause.

OLD:
```ts
    } catch {
      setErrorMsg("Authentication failed");
    } finally {
```
NEW:
```ts
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Approval failed");
    } finally {
```

## Change 5 — `apps/mobile/lib/session/provider.tsx`: expose trustedDesktop

The home screen needs to distinguish "no trusted desktop" from "trusted desktop unreachable".

(a) In `RelayContextValue`, after the `status` line:
OLD:
```ts
export interface RelayContextValue {
  status: ClientStatus | "idle";
  sessions: EstablishedSession[];
```
NEW:
```ts
export interface RelayContextValue {
  status: ClientStatus | "idle";
  trustedDesktop: TrustedDesktop | null;
  sessions: EstablishedSession[];
```

(b) Next to the other state declarations:
OLD:
```ts
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
```
NEW:
```ts
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
  const [trustedDesktop, setTrustedDesktop] = useState<TrustedDesktop | null>(null);
```

(c) In the init effect, right after `trustedRef.current = trusted;`:
OLD:
```ts
        trustedRef.current = trusted;
        if (!trusted) {
```
NEW:
```ts
        trustedRef.current = trusted;
        setTrustedDesktop(trusted);
        if (!trusted) {
```

(d) In the context value:
OLD:
```ts
  const value: RelayContextValue = {
    status,
    sessions,
```
NEW:
```ts
  const value: RelayContextValue = {
    status,
    trustedDesktop,
    sessions,
```

## Change 6 — `apps/mobile/app/index.tsx`: honest pair card

Add `trustedDesktop` to the existing `useRelay()` destructuring, then:

OLD:
```ts
  const isNoTrustedDesktop = status === "idle" && sessions.length === 0;
```
NEW:
```ts
  const isNoTrustedDesktop = !trustedDesktop;
  const isReconnecting = !!trustedDesktop && status !== "online";
```

Then, immediately after the `{isNoTrustedDesktop && (...)}` pair-card block (before the `{/* Pending approvals banner */}` comment), add:
```tsx
        {/* Reconnecting card when a desktop is trusted but the relay is unreachable */}
        {isReconnecting && (
          <View style={styles.pairCard}>
            <Text style={styles.cardTitle}>Reconnecting to desktop…</Text>
            <Text style={styles.cardBody}>
              Your paired desktop is configured but unreachable. Make sure the
              laptop is awake and on the network — no need to pair again.
            </Text>
          </View>
        )}
```
Also update the stale comment `{/* Pairing prompt card if idle and not paired */}` to `{/* Pairing prompt card when no trusted desktop */}`.

## Change 7 — `apps/mobile/lib/session/provider.tsx`: grant-routing precedence (user pairing wins)

If the app-start re-handshake is still in flight for the same desktop when the user starts pairing, abandon the re-handshake so a late grant can never be fed to the wrong `NoiseIKInitiator`. (`PairingManager.hasPendingPairing(deviceId)` already exists — use it to detect the collision.)

OLD:
```ts
      const client = connectToRelay(advert.relayUrl);
      const manager = new PairingManager({ deviceId, staticKeypair: keypair });
```
NEW:
```ts
      // Precedence rule: user-initiated pairing wins. If the app-start
      // re-handshake is still in flight for this desktop, abandon it so a
      // late grant can never be fed to the wrong Noise initiator.
      // (Desktop contract: a desktop MUST only grant the most recent
      // pairing_request per mobile deviceId; earlier ones are superseded.)
      if (pairingManagerRef.current?.hasPendingPairing(advert.desktopDeviceId)) {
        pairingManagerRef.current = null;
      }
      const client = connectToRelay(advert.relayUrl);
      const manager = new PairingManager({ deviceId, staticKeypair: keypair });
```

## Change 8 — `apps/mobile/app/pair.tsx`: never report success without a saved record

The "Codes match" handler currently swallows `saveTrustedDesktop()` failure and shows success anyway.

OLD:
```tsx
                try {
                  await saveTrustedDesktop({
                    deviceId: advert.desktopDeviceId,
                    staticPublicKeyB64: advert.desktopPublicKey,
                    relayUrl: advert.relayUrl,
                    lanRelayUrl: advert.lanRelayUrl,
                  });
                } catch {
                  // ignore
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
```
(Uses the existing error step and its message state.)

## Change 9 — `apps/mobile/lib/relay/client.ts`: signer failure tears down the socket

If the hello signer throws, the socket is currently left marked `"online"` with no hello ever sent.

OLD:
```ts
          helloSignature: bytesToBase64(sig),
          };
        } catch {
          return;
        }
```
NEW:
```ts
          helloSignature: bytesToBase64(sig),
          };
        } catch {
          // The hello could not be signed. Tear the socket down and let the
          // reconnect loop retry — a socket must never stay "online"
          // without a hello sent.
          this.cleanupCurrentSocket();
          handleDisconnect();
          return;
        }
```

## Change 10 — delete `apps/mobile/lib/relay/useRelay.ts`

Delete the file entirely. Nothing imports it (verify with grep before deleting) — and it would send unsigned hellos if anyone revived it, since it never passes a `helloSigner`.

## Change 11 — `apps/mobile/lib/session/provider.tsx`: remove the dead presence map

It is keyed by `env.from` (wrong for relay-generated presence) and never read anywhere.

(a) Delete the declaration line:
```ts
  const presenceByDeviceRef = useRef<Map<string, Presence>>(new Map());
```
(b) Delete the branch:
OLD:
```ts
      } else if (env.kind === "presence") {
        presenceByDeviceRef.current.set(env.from, env.payload as Presence);
      } else if (env.kind === "agent_status") {
```
NEW:
```ts
      } else if (env.kind === "agent_status") {
```
(c) If the `Presence` type import becomes unused, remove it from the `@bimax/protocol` import (`tsc`/`eslint` will confirm).

## Change 12 — `apps/mobile/lib/session/provider.tsx`: remove raw send() from the context

Raw `send()` bypasses E2E framing — and grep confirms no screen uses it.

(a) In `RelayContextValue`, delete:
```ts
  send: (env: Envelope<MessageKind, unknown>) => void;
```
(b) Delete the whole `send` useCallback (~line 388):
```ts
  const send = useCallback((env: Envelope<MessageKind, unknown>) => {
    if (clientRef.current) {
      clientRef.current.send(env);
    }
  }, []);
```
(c) In the context value, delete the `send,` entry. (If you find a real caller, keep it and report which file.)

## SCOPE — DO NOT DO

Nothing beyond the twelve changes. No protocol changes (the approval request-hash binding is protocol v1.6, a separate prompt). No relay changes. No new dependencies. No UI redesign beyond the two cards in Change 6. Do not touch `apps/mobile/lib/crypto`, `apps/mobile/lib/e2e`, or any test file except adding the new test in the acceptance suite.

## ACCEPTANCE (repo root, paste the FULL terminal output)

1. `npx tsc --noEmit` → zero errors
2. `npx eslint .` → zero errors
3. Every test script in `apps/mobile/package.json` (noise-kat, pairing, approvals, e2e, control, hello-auth, relay-smoke, nonce) → all PASS
4. NEW test in `apps/mobile/test/approvals-test.mjs`: `decideWithBiometric` with an async `onDecision` that throws must produce a rejected promise (not fire-and-forget); with an async `onDecision` that resolves, the promise must resolve only after `onDecision` completes (assert ordering with a flag)
5. `grep -rn "useRelay" apps/mobile --include="*.ts" --include="*.tsx"` → no hits (file gone, nothing imported it); `grep -n "presenceByDeviceRef" apps/mobile/lib/session/provider.tsx` → no hits

## RETURN FOR REVIEW (paste all three)

1. Confirmation of each of the 12 changes (one line per change: file + what was done)
2. The FULL terminal output of acceptance commands 1–5
3. The FULL output of the new approvals-test step
