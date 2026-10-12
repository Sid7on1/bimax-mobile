# Bimax Mobile — Fix #2: single relay-client owner (pairing through the provider)

Copy everything below the line into Antigravity as one prompt.

---

You are fixing a real integration bug from the architecture review. Background: Prompt #7 created `RelayProvider` as the single relay-client owner for the app — but `pair.tsx` still creates its OWN standalone `RelayClient`. The relay evicts the older socket when the same deviceId re-hellos, so the two clients fight forever: each one's hello kills the other's socket, pairing can never complete, and both churn through reconnect backoff indefinitely. (First pairing works because the provider is idle then; re-pairing while the provider is connected is broken.)

The fix: the provider becomes the ONLY place that ever creates a `RelayClient`. The pair screen drives pairing through the provider. No new dependencies, no protocol changes.

## Change 1 — rewrite `apps/mobile/lib/session/provider.tsx` wholesale

Replace the entire file with the version below. It preserves all existing behavior (approve/deny/signing/biometric wiring, approval routing, presence map, re-handshake on mount) and adds: `connectToRelay` (single client factory), an extracted `handleIncoming` router, and `pairWithDesktop` (user-initiated pairing through the provider's client).

```tsx
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import * as LocalAuthentication from "expo-local-authentication";
import type {
  Envelope,
  MessageKind,
  ToolApprovalRequest,
  ApprovalDecision,
  PairingAdvertisement,
  PairingGrant,
  Presence,
} from "@bimax/protocol";
import { RelayClient, type ClientStatus, type WsImpl } from "../relay/client";
import {
  getOrCreateDeviceId,
  loadTrustedDesktop,
  loadDeviceKey,
  getOrCreateX25519Keypair,
  getOrCreateEd25519Keypair,
  BIMAX_X25519_PRIV,
  BIMAX_ED25519_PRIV,
  base64ToBytes,
  x25519GetPublicKey,
  type TrustedDesktop,
} from "../crypto";
import { PairingManager, type EstablishedSession } from "./session";
import {
  addApproval,
  getPending,
  removeApproval,
  buildApprovalDecision,
  signApprovalDecision,
  decideWithBiometric,
} from "../approvals";

export interface RelayContextValue {
  status: ClientStatus | "idle";
  sessions: EstablishedSession[];
  getSession: (peerId: string) => EstablishedSession | undefined;
  pendingApprovals: ToolApprovalRequest[];
  approve: (approvalId: string) => Promise<void>;
  deny: (approvalId: string, reason?: "not_me" | "mistake") => Promise<void>;
  send: (env: Envelope<MessageKind, unknown>) => void;
  pairWithDesktop: (advert: PairingAdvertisement) => Promise<EstablishedSession>;
}

const RelayContext = createContext<RelayContextValue | null>(null);

export function useRelayContext(): RelayContextValue {
  const ctx = useContext(RelayContext);
  if (!ctx) {
    throw new Error("useRelayContext must be used within a RelayProvider");
  }
  return ctx;
}

interface UserPairing {
  manager: PairingManager;
  resolve: (s: EstablishedSession) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function RelayProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ClientStatus | "idle">("idle");
  const [sessions, setSessions] = useState<EstablishedSession[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);

  const clientRef = useRef<RelayClient | null>(null);
  const clientUrlRef = useRef<string | null>(null);
  const pairingManagerRef = useRef<PairingManager | null>(null);
  const userPairingsRef = useRef(new Map<string, UserPairing>());
  const deviceIdRef = useRef<string>("");
  const staticKeypairRef = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);
  const trustedRef = useRef<TrustedDesktop | null>(null);
  const presenceByDeviceRef = useRef<Map<string, Presence>>(new Map());

  useEffect(() => {
    const timer = setInterval(() => {
      setPendingApprovals(getPending());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleIncoming = useCallback((env: Envelope<MessageKind, unknown>) => {
    if (env.kind === "pairing_grant") {
      const grantEnv = env as Envelope<"pairing_grant", PairingGrant>;
      const pending = userPairingsRef.current.get(grantEnv.from);
      const manager = pending?.manager ?? pairingManagerRef.current;
      if (!manager) return;
      try {
        const session = manager.handleGrant(grantEnv);
        setSessions((prev) => [
          ...prev.filter((s) => s.peerDeviceId !== grantEnv.from),
          session,
        ]);
        if (pending) {
          clearTimeout(pending.timer);
          userPairingsRef.current.delete(grantEnv.from);
          pending.resolve(session);
        }
      } catch (err) {
        setSessions((prev) => prev.filter((s) => s.peerDeviceId !== grantEnv.from));
        if (pending) {
          clearTimeout(pending.timer);
          userPairingsRef.current.delete(grantEnv.from);
          pending.reject(err instanceof Error ? err : new Error("Pairing failed"));
        }
      }
    } else if (env.kind === "approval_request") {
      try {
        addApproval(env.payload as ToolApprovalRequest);
        setPendingApprovals(getPending());
      } catch {
        // ignore duplicate or malformed
      }
    } else if (env.kind === "presence") {
      presenceByDeviceRef.current.set(env.from, env.payload as Presence);
    }
  }, []);

  const connectToRelay = useCallback(
    (relayUrl: string): RelayClient => {
      if (clientRef.current && clientUrlRef.current === relayUrl) {
        return clientRef.current;
      }
      if (clientRef.current) {
        try {
          clientRef.current.close();
        } catch {
          // ignore
        }
        clientRef.current = null;
      }
      const client = new RelayClient({
        url: relayUrl,
        deviceId: deviceIdRef.current,
        role: "mobile",
        wsImpl: ((): WsImpl => {
          if (typeof WebSocket === "undefined") {
            throw new Error("Global WebSocket is not available");
          }
          return WebSocket as unknown as WsImpl;
        })(),
        onStatus: (s) => setStatus(s),
        onMessage: handleIncoming,
      });
      clientRef.current = client;
      clientUrlRef.current = relayUrl;
      client.connect();
      return client;
    },
    [handleIncoming],
  );

  const send = useCallback((env: Envelope<MessageKind, unknown>) => {
    if (clientRef.current) {
      clientRef.current.send(env);
    }
  }, []);

  const getSession = useCallback(
    (peerId: string): EstablishedSession | undefined => {
      return sessions.find((s) => s.peerDeviceId === peerId);
    },
    [sessions],
  );

  const pairWithDesktop = useCallback(
    (advert: PairingAdvertisement): Promise<EstablishedSession> => {
      const keypair = staticKeypairRef.current;
      const deviceId = deviceIdRef.current;
      if (!keypair || !deviceId) {
        return Promise.reject(new Error("Device identity not loaded yet"));
      }
      const client = connectToRelay(advert.relayUrl);
      const manager = new PairingManager({ deviceId, staticKeypair: keypair });
      let reqEnv: Envelope<"pairing_request", import("@bimax/protocol").PairingRequest>;
      try {
        reqEnv = manager.beginPairing(advert);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error("beginPairing failed"));
      }
      return new Promise<EstablishedSession>((resolve, reject) => {
        const timer = setTimeout(() => {
          userPairingsRef.current.delete(advert.desktopDeviceId);
          reject(new Error("Pairing timed out after 60s waiting for desktop approval"));
        }, 60000);
        userPairingsRef.current.set(advert.desktopDeviceId, { manager, resolve, reject, timer });
        client.send(reqEnv);
      });
    },
    [connectToRelay],
  );

  const getEd25519PrivateKey = async (): Promise<Uint8Array> => {
    let privB64 = await loadDeviceKey(BIMAX_ED25519_PRIV);
    if (!privB64) {
      await getOrCreateEd25519Keypair();
      privB64 = await loadDeviceKey(BIMAX_ED25519_PRIV);
    }
    if (!privB64) {
      throw new Error("Failed to load or generate Ed25519 private key");
    }
    return base64ToBytes(privB64);
  };

  const approve = useCallback(
    async (approvalId: string): Promise<void> => {
      const req = pendingApprovals.find((a) => a.approvalId === approvalId);
      if (!req) {
        throw new Error(`Approval request ${approvalId} not found`);
      }
      await decideWithBiometric({
        requestBiometric: async () => {
          const authRes = await LocalAuthentication.authenticateAsync({
            promptMessage: `Approve ${req.tool}?`,
            disableDeviceFallback: true,
          });
          return authRes.success;
        },
        build: () => buildApprovalDecision(req, "approved"),
        sign: (unsigned) => ({ ...unsigned, signature: "" }),
        onDecision: async (dec) => {
          const privKey = await getEd25519PrivateKey();
          const { signature: _sig, ...unsigned } = dec;
          const signed = signApprovalDecision(unsigned, privKey);
          const env: Envelope<"approval_decision", ApprovalDecision> = {
            v: 1,
            id: "m-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36),
            ts: Date.now(),
            from: deviceIdRef.current,
            to: trustedRef.current?.deviceId ?? "desktop",
            kind: "approval_decision",
            payload: signed,
          };
          send(env);
          removeApproval(approvalId);
          setPendingApprovals(getPending());
        },
        onDenied: (reason) => {
          throw new Error(`Biometric authentication failed: ${reason}`);
        },
      });
    },
    [pendingApprovals, send],
  );

  const deny = useCallback(
    async (approvalId: string, reason?: "not_me" | "mistake"): Promise<void> => {
      const req = pendingApprovals.find((a) => a.approvalId === approvalId);
      if (!req) {
        throw new Error(`Approval request ${approvalId} not found`);
      }
      const privKey = await getEd25519PrivateKey();
      const unsigned = buildApprovalDecision(req, "denied", reason);
      const signed = signApprovalDecision(unsigned, privKey);
      const env: Envelope<"approval_decision", ApprovalDecision> = {
        v: 1,
        id: "m-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36),
        ts: Date.now(),
        from: deviceIdRef.current,
        to: trustedRef.current?.deviceId ?? "desktop",
        kind: "approval_decision",
        payload: signed,
      };
      send(env);
      removeApproval(approvalId);
      setPendingApprovals(getPending());
    },
    [pendingApprovals, send],
  );

  useEffect(() => {
    let isMounted = true;
    async function init() {
      try {
        const deviceId = await getOrCreateDeviceId();
        if (!isMounted) return;
        deviceIdRef.current = deviceId;
        await getOrCreateX25519Keypair();
        const privB64 = await loadDeviceKey(BIMAX_X25519_PRIV);
        if (!privB64) throw new Error("Private key not found in secure storage");
        if (!isMounted) return;
        const privateKey = base64ToBytes(privB64);
        staticKeypairRef.current = {
          publicKey: x25519GetPublicKey(privateKey),
          privateKey,
        };
        const trusted = await loadTrustedDesktop();
        if (!isMounted) return;
        trustedRef.current = trusted;
        if (!trusted) {
          setStatus("idle");
          return;
        }
        const pairingManager = new PairingManager({
          deviceId,
          staticKeypair: staticKeypairRef.current,
        });
        pairingManagerRef.current = pairingManager;
        // Note: the future desktop auto-approves pairing_requests from already-known static keys.
        const rehandshakeAdvert = {
          relayUrl: trusted.relayUrl,
          ref: "rehandshake-" + Math.random().toString(36).slice(2),
          desktopDeviceId: trusted.deviceId,
          desktopPublicKey: trusted.staticPublicKeyB64,
          app: "bimax" as const,
        };
        const client = connectToRelay(trusted.relayUrl);
        const reqEnv = pairingManager.beginPairing(rehandshakeAdvert);
        client.send(reqEnv);
      } catch {
        if (isMounted) setStatus("idle");
      }
    }
    init();
    return () => {
      isMounted = false;
      for (const [, p] of userPairingsRef.current) {
        clearTimeout(p.timer);
        p.reject(new Error("Provider unmounted"));
      }
      userPairingsRef.current.clear();
      pairingManagerRef.current = null;
      if (clientRef.current) {
        try {
          clientRef.current.close();
        } catch {
          // ignore
        }
        clientRef.current = null;
      }
      clientUrlRef.current = null;
    };
  }, [connectToRelay]);

  const value: RelayContextValue = {
    status,
    sessions,
    getSession,
    pendingApprovals,
    approve,
    deny,
    send,
    pairWithDesktop,
  };

  return <RelayContext.Provider value={value}>{children}</RelayContext.Provider>;
}
```

(Note: the `import("@bimax/protocol").PairingRequest` inline type in `pairWithDesktop` may be replaced with a top-level type import of `PairingRequest` — whichever passes `tsc --noEmit` cleanly.)

## Change 2 — `apps/mobile/app/pair.tsx`: drive pairing through the provider

1. Remove the `RelayClient` / `WsImpl` import; add `import { useRelayContext } from "../lib/session/provider";`.
2. Remove `relayClientRef`, `timeoutTimerRef`, `cleanupRelay`, and the unmount cleanup effect. Remove `useCallback` from the React import if nothing else uses it. Remove crypto imports that become unused (`getOrCreateDeviceId`, `getOrCreateX25519Keypair`, `loadDeviceKey`, `BIMAX_X25519_PRIV`, `base64ToBytes`, `x25519GetPublicKey`, `PairingManager`) — keep `parseAdvertisement`, `saveTrustedDesktop`, `formatVerificationCode`, `type EstablishedSession`.
3. Replace `startPairingFlow` wholesale with:
```tsx
const { pairWithDesktop } = useRelayContext();

const startPairingFlow = async () => {
  if (!advert) return;
  setStep("pairing");
  setErrorMessage("");
  try {
    const established = await pairWithDesktop(advert);
    setSession(established);
    setStep("verifying");
  } catch (err) {
    setErrorMessage(err instanceof Error ? err.message : "Pairing failed");
    setStep("error");
  }
};
```
4. Remove all `cleanupRelay()` calls ("Codes match — Done", "Doesn't match", Retry button). The trusted-desktop save on "Codes match — Done" stays.

## Change 3 — `apps/mobile/lib/approvals/approvals.ts`: strict decision mapping

`buildApprovalDecision` currently maps ANY unrecognized `decision` value to `"denied"` silently. Make it throw instead. Change EXACTLY:
OLD:
```ts
  const decisionValue: ApprovalDecisionValue =
    decision === "approve" || decision === "approved" ? "approved" : "denied";
```
NEW:
```ts
  let decisionValue: ApprovalDecisionValue;
  if (decision === "approve" || decision === "approved") {
    decisionValue = "approved";
  } else if (decision === "deny" || decision === "denied") {
    decisionValue = "denied";
  } else {
    throw new Error(`buildApprovalDecision: invalid decision ${String(decision)}`);
  }
```

## SCOPE — DO NOT DO

Nothing beyond the three changes. No new dependencies, no UI redesigns, no protocol changes. Do not touch apps/relay, the relay client, or crypto files.

## ACCEPTANCE (repo root, paste the FULL terminal output)

1. `npx tsc --noEmit` → zero errors
2. `npx eslint .` → zero errors
3. `node apps/mobile/test/pairing-test.mjs` → all five steps PASS (regression)
4. `node apps/mobile/test/approvals-test.mjs` → all four steps PASS (regression)

## RETURN FOR REVIEW (paste all three)

1. Confirmation that `apps/mobile/app/pair.tsx` no longer imports or constructs `RelayClient` (paste the import block + `startPairingFlow`)
2. The FULL terminal output of acceptance commands 1–4
3. The FULL output of both regression test runs
