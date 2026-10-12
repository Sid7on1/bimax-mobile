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
  PairingAdvertisement,
  PairingRequest,
  PairingGrant,
  Presence,
  EncryptedPayload,
  AgentStatus,
  AgentSessionInfo,
  SessionList,
  CommandRequest,
  CommandResult,
  KillRequest,
  KillResult,
} from "@bimax/protocol";
import { RelayClient, type ClientStatus, type WsImpl } from "../relay/client";
import {
  getOrCreateDeviceId,
  loadTrustedDesktop,
  saveTrustedDesktop,
  loadDeviceKey,
  getOrCreateX25519Keypair,
  getOrCreateEd25519Keypair,
  BIMAX_X25519_PRIV,
  BIMAX_ED25519_PRIV,
  base64ToBytes,
  bytesToBase64,
  x25519GetPublicKey,
  ed25519Sign,
  ed25519GetPublicKey,
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
import {
  seal,
  open,
  newE2EState,
  type E2EState,
  type OpenResult,
} from "../e2e";

export interface CommandLogEntry {
  idempotencyKey: string;
  instruction: string;
  status: "sent" | "acked" | "failed";
  summary?: string;
  at: number;
}

export interface RelayContextValue {
  status: ClientStatus | "idle";
  sessions: EstablishedSession[];
  getSession: (peerId: string) => EstablishedSession | undefined;
  pendingApprovals: ToolApprovalRequest[];
  approve: (approvalId: string) => Promise<void>;
  deny: (approvalId: string, reason?: "not_me" | "mistake") => Promise<void>;
  send: (env: Envelope<MessageKind, unknown>) => void;
  sendEncrypted: (to: string, kind: MessageKind, payload: unknown) => void;
  pairWithDesktop: (advert: PairingAdvertisement) => Promise<EstablishedSession>;
  agentStatus: AgentStatus | null;
  remoteSessions: AgentSessionInfo[];
  commandLog: CommandLogEntry[];
  sendInstruction: (instruction: string) => void;
  requestSessionList: () => void;
  sendKill: (reason?: string) => void;
  lastKillAck: KillResult | null;
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
  const [lastKillAck, setLastKillAck] = useState<KillResult | null>(null);
  const [sessions, setSessions] = useState<EstablishedSession[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<ToolApprovalRequest[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [remoteSessions, setRemoteSessions] = useState<AgentSessionInfo[]>([]);
  const [commandLog, setCommandLog] = useState<CommandLogEntry[]>([]);

  const statusRef = useRef<ClientStatus | "idle">("idle");
  const helloSignerRef = useRef<{
    pubkeyB64: string;
    sign: (msg: Uint8Array) => Promise<Uint8Array>;
  } | null>(null);

  const clientRef = useRef<RelayClient | null>(null);
  const clientUrlRef = useRef<string | null>(null);
  const pairingManagerRef = useRef<PairingManager | null>(null);
  const userPairingsRef = useRef(new Map<string, UserPairing>());
  const deviceIdRef = useRef<string>("");
  const staticKeypairRef = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);
  const trustedRef = useRef<TrustedDesktop | null>(null);
  const presenceByDeviceRef = useRef<Map<string, Presence>>(new Map());

  const sessionsRef = useRef<EstablishedSession[]>([]);
  const e2eStateRef = useRef(new Map<string, E2EState>());

  const getE2EState = useCallback((peerId: string): E2EState => {
    let state = e2eStateRef.current.get(peerId);
    if (!state) {
      state = newE2EState();
      e2eStateRef.current.set(peerId, state);
    }
    return state;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setPendingApprovals(getPending());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleIncoming = useCallback(
    (env: Envelope<MessageKind, unknown>) => {
      if (env.kind === "encrypted") {
        const encPayload = env.payload as EncryptedPayload | null | undefined;
        if (
          !encPayload ||
          typeof encPayload !== "object" ||
          typeof encPayload.ciphertext !== "string"
        ) {
          return;
        }

        const session = sessionsRef.current.find(
          (s) => s.peerDeviceId === env.from,
        );
        if (!session) {
          return;
        }

        const state = getE2EState(env.from);
        let result: OpenResult;
        try {
          result = open(session, state, {
            id: env.id,
            from: env.from,
            to: deviceIdRef.current,
            kind: env.kind,
            ciphertextB64: encPayload.ciphertext,
          });
        } catch {
          return;
        }

        if (result.duplicate) {
          return;
        }

        handleIncoming({
          v: env.v,
          id: env.id,
          ts: env.ts,
          from: env.from,
          to: deviceIdRef.current,
          kind: result.innerKind,
          payload: result.body,
        });
        return;
      }

      if (env.kind === "pairing_grant") {
        const grantEnv = env as Envelope<"pairing_grant", PairingGrant>;
        const pending = userPairingsRef.current.get(grantEnv.from);
        const manager = pending?.manager ?? pairingManagerRef.current;
        if (!manager) return;
        try {
          const session = manager.handleGrant(grantEnv);
          setSessions((prev) => {
            const next = [
              ...prev.filter((s) => s.peerDeviceId !== grantEnv.from),
              session,
            ];
            sessionsRef.current = next;
            return next;
          });
          if (pending) {
            clearTimeout(pending.timer);
            userPairingsRef.current.delete(grantEnv.from);
            pending.resolve(session);
          }
        } catch (err) {
          setSessions((prev) => {
            const next = prev.filter((s) => s.peerDeviceId !== grantEnv.from);
            sessionsRef.current = next;
            return next;
          });
          if (pending) {
            clearTimeout(pending.timer);
            userPairingsRef.current.delete(grantEnv.from);
            pending.reject(
              err instanceof Error ? err : new Error("Pairing failed"),
            );
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
      } else if (env.kind === "agent_status") {
        const statusPayload = env.payload as AgentStatus | null | undefined;
        if (
          statusPayload &&
          typeof statusPayload === "object" &&
          (statusPayload.state === "idle" ||
            statusPayload.state === "working" ||
            statusPayload.state === "waiting_approval" ||
            statusPayload.state === "error")
        ) {
          setAgentStatus({
            state: statusPayload.state,
            sessionId:
              typeof statusPayload.sessionId === "string"
                ? statusPayload.sessionId.slice(0, 100)
                : undefined,
            taskSummary:
              typeof statusPayload.taskSummary === "string"
                ? statusPayload.taskSummary.slice(0, 200)
                : undefined,
            updatedAt:
              typeof statusPayload.updatedAt === "number" &&
              Number.isFinite(statusPayload.updatedAt)
                ? statusPayload.updatedAt
                : Date.now(),
          });
        }
      } else if (env.kind === "session_list") {
        const listPayload = env.payload as SessionList | null | undefined;
        if (listPayload && Array.isArray(listPayload.sessions)) {
          const valid: AgentSessionInfo[] = [];
          for (const item of listPayload.sessions) {
            if (
              item &&
              typeof item === "object" &&
              typeof item.sessionId === "string" &&
              item.sessionId.length > 0 &&
              typeof item.title === "string" &&
              (item.status === "idle" ||
                item.status === "working" ||
                item.status === "waiting_approval" ||
                item.status === "error")
            ) {
              valid.push({
                sessionId: item.sessionId.slice(0, 100),
                title: item.title.slice(0, 200),
                status: item.status,
                startedAt:
                  typeof item.startedAt === "number" &&
                  Number.isFinite(item.startedAt)
                    ? item.startedAt
                    : Date.now(),
              });
              if (valid.length >= 50) break;
            }
          }
          setRemoteSessions(valid);
        }
      } else if (env.kind === "command_result") {
        const resultPayload = env.payload as CommandResult | null | undefined;
        if (
          resultPayload &&
          typeof resultPayload === "object" &&
          typeof resultPayload.idempotencyKey === "string"
        ) {
          const key = resultPayload.idempotencyKey;
          const newStatus = resultPayload.ok ? "acked" : "failed";
          const summary =
            typeof resultPayload.summary === "string"
              ? resultPayload.summary.slice(0, 300)
              : undefined;
          setCommandLog((prev) =>
            prev.map((entry) =>
              entry.idempotencyKey === key
                ? { ...entry, status: newStatus, summary }
                : entry,
            ),
          );
        }
      } else if (env.kind === "kill_result") {
        const killPayload = env.payload as KillResult | null | undefined;
        if (
          killPayload &&
          typeof killPayload === "object" &&
          typeof killPayload.idempotencyKey === "string" &&
          killPayload.idempotencyKey.length > 0 &&
          typeof killPayload.ok === "boolean"
        ) {
          const detail =
            typeof killPayload.detail === "string"
              ? killPayload.detail.slice(0, 300)
              : undefined;
          const at =
            typeof killPayload.at === "number" &&
            Number.isFinite(killPayload.at)
              ? killPayload.at
              : Date.now();
          setLastKillAck({
            idempotencyKey: killPayload.idempotencyKey,
            ok: killPayload.ok,
            detail,
            at,
          });
        }
      }
    },
    [getE2EState],
  );

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
        helloSigner: helloSignerRef.current ?? undefined,
        onStatus: (s) => {
          statusRef.current = s;
          setStatus(s);
        },
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

  const sendEncrypted = useCallback(
    (to: string, kind: MessageKind, payload: unknown): void => {
      if (!clientRef.current) {
        throw new Error("sendEncrypted: relay client is not connected");
      }
      const session = sessionsRef.current.find((s) => s.peerDeviceId === to);
      if (!session) {
        throw new Error(`sendEncrypted: no established session for peer ${to}`);
      }
      const state = getE2EState(to);
      const randomId =
        "m-" +
        Math.random().toString(36).slice(2) +
        "-" +
        Date.now().toString(36);
      const outer = {
        id: randomId,
        from: deviceIdRef.current,
        to,
      };
      const ciphertext = seal(session, state, kind, payload, outer);
      const env: Envelope<"encrypted", EncryptedPayload> = {
        v: 1,
        id: outer.id,
        ts: Date.now(),
        from: outer.from,
        to: outer.to,
        kind: "encrypted",
        payload: { ciphertext },
      };
      clientRef.current.send(env);
    },
    [getE2EState],
  );

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
      let reqEnv: Envelope<"pairing_request", PairingRequest>;
      try {
        reqEnv = manager.beginPairing(advert);
      } catch (err) {
        return Promise.reject(
          err instanceof Error ? err : new Error("beginPairing failed"),
        );
      }
      return new Promise<EstablishedSession>((resolve, reject) => {
        const timer = setTimeout(() => {
          userPairingsRef.current.delete(advert.desktopDeviceId);
          reject(
            new Error(
              "Pairing timed out after 60s waiting for desktop approval",
            ),
          );
        }, 60000);
        userPairingsRef.current.set(advert.desktopDeviceId, {
          manager,
          resolve,
          reject,
          timer,
        });
        client.send(reqEnv);
      });
    },
    [connectToRelay],
  );

  const requireDesktopId = useCallback((): string => {
    const desktopId = trustedRef.current?.deviceId;
    if (!desktopId) {
      throw new Error("No trusted desktop configured");
    }
    return desktopId;
  }, []);

  const sendInstruction = useCallback(
    (instruction: string): void => {
      const trimmed = instruction.trim();
      if (trimmed.length === 0) {
        throw new Error("Instruction cannot be empty");
      }
      if (trimmed.length > 4000) {
        throw new Error("Instruction exceeds maximum length of 4000 characters");
      }

      const desktopId = requireDesktopId();
      const idempotencyKey =
        "cmd-" +
        Math.random().toString(36).slice(2) +
        "-" +
        Date.now().toString(36);
      const now = Date.now();

      const req: CommandRequest = {
        instruction: trimmed,
        idempotencyKey,
        sentAt: now,
      };

      const entry: CommandLogEntry = {
        idempotencyKey,
        instruction: trimmed,
        status: "sent",
        at: now,
      };

      setCommandLog((prev) => [...prev, entry].slice(-20));
      try {
        sendEncrypted(desktopId, "command_request", req);
      } catch (err) {
        setCommandLog((prev) =>
          prev.map((e) =>
            e.idempotencyKey === idempotencyKey
              ? { ...e, status: "failed", summary: err instanceof Error ? err.message : "Send failed" }
              : e,
          ),
        );
        throw err;
      }
    },
    [requireDesktopId, sendEncrypted],
  );

  const requestSessionList = useCallback((): void => {
    const desktopId = requireDesktopId();
    sendEncrypted(desktopId, "session_list_request", {});
  }, [requireDesktopId, sendEncrypted]);

  const sendKill = useCallback(
    (reason?: string): void => {
      const desktopId = requireDesktopId();
      const idempotencyKey = "kill-" + Math.random().toString(36).slice(2);
      const req: KillRequest = {
        idempotencyKey,
        reason,
        sentAt: Date.now(),
      };
      setLastKillAck(null);
      sendEncrypted(desktopId, "kill_request", req);
    },
    [requireDesktopId, sendEncrypted],
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
      const desktopId = trustedRef.current?.deviceId;
      if (!desktopId) {
        throw new Error("No trusted desktop configured for approvals");
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
          sendEncrypted(desktopId, "approval_decision", signed);
          removeApproval(approvalId);
          setPendingApprovals(getPending());
        },
        onDenied: (reason) => {
          throw new Error(`Biometric authentication failed: ${reason}`);
        },
      });
    },
    [pendingApprovals, sendEncrypted],
  );

  const deny = useCallback(
    async (
      approvalId: string,
      reason?: "not_me" | "mistake",
    ): Promise<void> => {
      const req = pendingApprovals.find((a) => a.approvalId === approvalId);
      if (!req) {
        throw new Error(`Approval request ${approvalId} not found`);
      }
      const desktopId = trustedRef.current?.deviceId;
      if (!desktopId) {
        throw new Error("No trusted desktop configured for approvals");
      }

      const privKey = await getEd25519PrivateKey();
      const unsigned = buildApprovalDecision(req, "denied", reason);
      const signed = signApprovalDecision(unsigned, privKey);
      sendEncrypted(desktopId, "approval_decision", signed);
      removeApproval(approvalId);
      setPendingApprovals(getPending());
    },
    [pendingApprovals, sendEncrypted],
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

        const edPrivKey = await getEd25519PrivateKey();
        if (!isMounted) return;
        const edPubBytes = ed25519GetPublicKey(edPrivKey);
        const edPubkeyB64 = bytesToBase64(edPubBytes);
        helloSignerRef.current = {
          pubkeyB64: edPubkeyB64,
          sign: async (msg: Uint8Array) => ed25519Sign(edPrivKey, msg),
        };

        const trusted = await loadTrustedDesktop();
        if (!isMounted) return;
        trustedRef.current = trusted;
        if (!trusted) {
          statusRef.current = "idle";
          setStatus("idle");
          return;
        }
        const pairingManager = new PairingManager({
          deviceId,
          staticKeypair: staticKeypairRef.current,
        });
        pairingManagerRef.current = pairingManager;

        const candidateUrls: string[] =
          trusted.lanRelayUrl && trusted.lastWorking !== "cloud"
            ? [trusted.lanRelayUrl, trusted.relayUrl]
            : [
                trusted.relayUrl,
                ...(trusted.lanRelayUrl ? [trusted.lanRelayUrl] : []),
              ];

        let winningClient: RelayClient | null = null;
        let winningUrl: string | null = null;

        for (const url of candidateUrls) {
          if (!isMounted) return;
          const client = connectToRelay(url);

          const start = Date.now();
          let isOnline = false;
          while (Date.now() - start < 4000) {
            if (!isMounted) return;
            if (statusRef.current === "online") {
              isOnline = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 150));
          }

          if (!isMounted) return;
          if (isOnline) {
            winningClient = client;
            winningUrl = url;
            break;
          }
        }

        if (!isMounted) return;

        if (winningUrl && winningClient) {
          const lastWorking: "lan" | "cloud" =
            winningUrl === trusted.lanRelayUrl ? "lan" : "cloud";
          trustedRef.current = { ...trusted, lastWorking };
          try {
            await saveTrustedDesktop({
              deviceId: trusted.deviceId,
              staticPublicKeyB64: trusted.staticPublicKeyB64,
              relayUrl: trusted.relayUrl,
              lanRelayUrl: trusted.lanRelayUrl,
              lastWorking,
            });
          } catch {
            // ignore save error
          }

          const rehandshakeAdvert = {
            relayUrl: winningUrl,
            ref: "rehandshake-" + Math.random().toString(36).slice(2),
            desktopDeviceId: trusted.deviceId,
            desktopPublicKey: trusted.staticPublicKeyB64,
            app: "bimax" as const,
          };
          const reqEnv = pairingManager.beginPairing(rehandshakeAdvert);
          winningClient.send(reqEnv);
        } else {
          if (clientRef.current) {
            try {
              clientRef.current.close();
            } catch {
              // ignore
            }
            clientRef.current = null;
            clientUrlRef.current = null;
          }
          statusRef.current = "idle";
          setStatus("idle");
        }
      } catch {
        if (isMounted) {
          statusRef.current = "idle";
          setStatus("idle");
        }
      }
    }
    const userPairings = userPairingsRef.current;
    init();
    return () => {
      isMounted = false;
      for (const [, p] of userPairings) {
        clearTimeout(p.timer);
        p.reject(new Error("Provider unmounted"));
      }
      userPairings.clear();
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
    sendEncrypted,
    pairWithDesktop,
    agentStatus,
    remoteSessions,
    commandLog,
    sendInstruction,
    requestSessionList,
    sendKill,
    lastKillAck,
  };

  return <RelayContext.Provider value={value}>{children}</RelayContext.Provider>;
}
