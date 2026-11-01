import { SessionCreateClient } from "./session-create-client";
import { LiveConversationClient } from "./live-client";
import { HistoryClient } from "./history-client";
import { AppState, Platform } from "react-native";
import { relaySocketConstructor, type NativeWebSocketConstructor } from "../relay/native-socket";
import { pairingTimeout } from "./pairing-progress";
import {
  PairingAttemptScope,
  sameDesktopTrust,
  matchesDesktopSession,
} from "@bimax/core/session/attempt";
import { isPqAdvertisement } from "@bimax/core/crypto/pq";
import { buildTransportConfirmation } from "@bimax/core/session/lifecycle";
import { PqPrekeyLookup } from "@bimax/core/session/prekey-lookup";
import { randomId } from "../crypto/keys";
import { requireActiveAccount, isActiveAccount } from "../account-scope";
import { authorizeRelayUrl, registerPairedCloud } from "../gateway";
import { pendingOperations, acknowledgeOperation } from "../operation-outbox";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import type {
  RemoteConversation,
  Envelope,
  MessageKind,
  ToolApprovalRequest,
  PairingAdvertisement,
  PairingRequest,
  PairingGrant,
  EncryptedPayload,
  AgentStatus,
  AgentSessionInfo,
  MacWorkspace,
  KillResult,
  ChatDone,
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
import { addApproval, getPending } from "../approvals";
import { seal, open, newE2EState, type E2EState, type OpenResult } from "../e2e";
import { dispatchIncomingEnvelope } from "./incoming";
import { probeTrustedRelay } from "./connection";
import { useRemoteActions } from "./use-remote-actions";

export interface CommandLogEntry {
  idempotencyKey: string;
  instruction: string;
  status: "sent" | "acked" | "failed";
  summary?: string;
  at: number;
}

export interface RemoteChatOptions {
  text: string;
  sessionId?: string;
  fileIds?: string[];
  onToken?: (token: string, seq: number) => void;
}

export interface RemoteFileInput {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface PendingRemoteChat {
  onToken?: (token: string, seq: number) => void;
  resolve: (done: ChatDone) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingFileTransfer {
  bytes: Uint8Array;
  onAccepted: () => void;
  resolve: (fileId: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RelayContextValue {
  status: ClientStatus | "idle";
  connectionError: string | null;
  connectionRoute: "cloud" | "lan" | "none";
  cloudError: string | null;
  retryCloud: () => void;
  trustedDesktop: TrustedDesktop | null;
  refreshTrustedDesktop: (verified: EstablishedSession) => Promise<void>;
  sessions: EstablishedSession[];
  getSession: (peerId: string) => EstablishedSession | undefined;
  dropSession: (peerDeviceId: string) => void;
  pendingApprovals: ToolApprovalRequest[];
  approve: (approvalId: string) => Promise<void>;
  deny: (approvalId: string, reason?: "not_me" | "mistake") => Promise<void>;
  sendEncrypted: (to: string, kind: MessageKind, payload: unknown) => void;
  pairWithDesktop: (advert: PairingAdvertisement) => Promise<EstablishedSession>;
  agentStatus: AgentStatus | null;
  remoteSessions: AgentSessionInfo[];
  remoteWorkspaces: MacWorkspace[];
  canCreateSessions: boolean;
  createMacSession: (
    workspaceId: string,
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<string>;
  commandLog: CommandLogEntry[];
  sendInstruction: (instruction: string) => Promise<void>;
  sendRemoteChat: (options: RemoteChatOptions) => Promise<ChatDone>;
  sendRemoteFile: (file: RemoteFileInput) => Promise<string>;
  requestSessionList: () => void;
  watchConversation: (
    id: string,
    onUpdate: (snapshot: RemoteConversation) => void,
    onError: (error: Error) => void,
    signal?: AbortSignal,
  ) => () => void;
  requestSessionHistory: (id: string, signal?: AbortSignal) => Promise<RemoteConversation>;
  sendKill: (reason?: string) => Promise<void>;
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
  attemptId: number;
  isCurrent: () => boolean;
  finish: () => void;
}

export function RelayProvider({ children }: { children: ReactNode }) {
  const owner = requireActiveAccount();
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [status, setStatus] = useState<ClientStatus | "idle">("idle");
  const [trustedDesktop, setTrustedDesktop] = useState<TrustedDesktop | null>(null);
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
  const userPairingsRef = useRef(new Map<string, UserPairing>());
  const pendingChatsRef = useRef(new Map<string, PendingRemoteChat>());
  const pendingFilesRef = useRef(new Map<string, PendingFileTransfer>());
  const attemptCountersRef = useRef<Map<string, number>>(new Map());
  const rehandshakePairingRef = useRef<{
    attemptId: number;
    manager: PairingManager;
    request: Envelope<"pairing_request", PairingRequest>;
    startedAt: number;
    isCurrent: () => boolean;
    finish: () => void;
  } | null>(null);
  const userScopeRef = useRef(new PairingAttemptScope());
  const recoveryScopeRef = useRef(new PairingAttemptScope());
  const aliveRef = useRef(false);

  const getNextAttemptId = useCallback((peerDeviceId: string): number => {
    const current = attemptCountersRef.current.get(peerDeviceId) ?? 0;
    const next = current + 1;
    attemptCountersRef.current.set(peerDeviceId, next);
    return next;
  }, []);

  const deviceIdRef = useRef<string>("");
  const ownedPrivateKeys = useRef(new Set<Uint8Array>());
  const staticKeypairRef = useRef<{ publicKey: Uint8Array; privateKey: Uint8Array } | null>(null);
  const trustedRef = useRef<TrustedDesktop | null>(null);
  const prekeyLookupRef = useRef(new PqPrekeyLookup());

  const sessionsRef = useRef<EstablishedSession[]>([]);
  const recoverRef = useRef<() => void>(() => {});
  const lastFlushRef = useRef(0);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const historyRef = useRef(new HistoryClient());
  const creationRef = useRef(new SessionCreateClient());
  const [remoteWorkspaces, setRemoteWorkspaces] = useState<MacWorkspace[]>([]);
  const [canCreateSessions, setCanCreateSessions] = useState(false);
  const liveRef = useRef(new LiveConversationClient(historyRef.current));
  const connectRouteRef = useRef<(url: string) => RelayClient>(() => {
    throw Error("Connection is starting");
  });
  const encryptedSendRef = useRef<RelayContextValue["sendEncrypted"]>(() => {
    throw Error("Connection is starting");
  });
  const failoverRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cloudSetupRef = useRef<{
    session: EstablishedSession;
    working: boolean;
    relayUrl?: string;
  } | null>(null);
  const candidatesRef = useRef(new Map<string, EstablishedSession>());
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
      const next = getPending();
      setPendingApprovals((prev) =>
        prev.length === next.length &&
        prev.every((item, idx) => item.approvalId === next[idx]?.approvalId)
          ? prev
          : next,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const handleIncoming = useCallback(
    (env: Envelope<MessageKind, unknown>, authenticated = false) => {
      if (!isActiveAccount(owner)) return;
      if (prekeyLookupRef.current.handle(env, deviceIdRef.current)) return;
      dispatchIncomingEnvelope(
        env,
        {
          owner,
          isActiveAccount,
          deviceId: deviceIdRef.current,
          trustedDesktopId: trustedRef.current?.deviceId,
          onPresence: (deviceId, presenceStatus) => {
            if (presenceStatus === "offline") {
              for (const s of sessionsRef.current) {
                if (s.peerDeviceId === deviceId) s.destroy?.();
              }
              historyRef.current.clear();
              creationRef.current.clear();
              liveRef.current.clear();
              sessionsRef.current = [];
              setSessions([]);
            } else if (presenceStatus === "online") {
              recoverRef.current();
            }
          },
          onEncrypted: (outerEnv) => {
            const encPayload = outerEnv.payload as EncryptedPayload | null | undefined;
            if (
              !encPayload ||
              typeof encPayload !== "object" ||
              typeof encPayload.ciphertext !== "string"
            ) {
              return;
            }
            const session = sessionsRef.current.find((s) => s.peerDeviceId === outerEnv.from);
            if (!session) return;

            const state = getE2EState(outerEnv.from);
            let result: OpenResult;
            try {
              result = open(session, state, {
                id: outerEnv.id,
                from: outerEnv.from,
                to: deviceIdRef.current,
                kind: outerEnv.kind,
                ciphertextB64: encPayload.ciphertext,
              });
            } catch {
              session.destroy?.();
              historyRef.current.clear();
              creationRef.current.clear();
              liveRef.current.clear();
              sessionsRef.current = [];
              setSessions([]);
              recoveryScopeRef.current.cancel();
              rehandshakePairingRef.current?.manager.destroy();
              rehandshakePairingRef.current = null;
              recoverRef.current();
              return;
            }
            if (result.duplicate) return;

            handleIncoming(
              {
                v: outerEnv.v,
                id: outerEnv.id,
                ts: outerEnv.ts,
                from: outerEnv.from,
                to: deviceIdRef.current,
                kind: result.innerKind,
                payload: result.body,
              },
              true,
            );
          },
          onPairingGrant: (rawGrant) => {
            const grantEnv = rawGrant as Envelope<"pairing_grant", PairingGrant>;
            const peerId = grantEnv.from;

            const userPending = userPairingsRef.current.get(peerId);
            const rehandshakePending =
              rehandshakePairingRef.current &&
              rehandshakePairingRef.current.manager.hasPendingPairing(peerId)
                ? rehandshakePairingRef.current
                : null;

            if (!userPending && !rehandshakePending) return;

            const userAttemptId = userPending?.attemptId ?? -1;
            const rehandshakeAttemptId = rehandshakePending?.attemptId ?? -1;
            const isUser = userAttemptId >= rehandshakeAttemptId;
            const attempt = isUser ? userPending! : rehandshakePending!;
            const manager = attempt.manager;
            if (!attempt.isCurrent() || !manager.matchesPendingGrant(grantEnv)) return;

            try {
              const session = manager.handleGrant(grantEnv);
              setConnectionError(null);
              if (!isUser && session.nextPqPrekey && trustedRef.current) {
                const updated = {
                  ...trustedRef.current,
                  cryptoVersion: 2 as const,
                  nextPqPrekey: session.nextPqPrekey,
                };
                trustedRef.current = updated;
                setTrustedDesktop(updated);
                void saveTrustedDesktop(updated).catch(() =>
                  setConnectionError(
                    "Could not save the next secure reconnect key. Scan a fresh QR code if reconnect fails.",
                  ),
                );
              }
              if (session.requiresConfirmation) {
                clientRef.current!.send(buildTransportConfirmation(session, deviceIdRef.current));
              }
              e2eStateRef.current.set(peerId, newE2EState());
              if (isUser) {
                candidatesRef.current.set(peerId, session);
              } else {
                const next = [
                  ...sessionsRef.current.filter((s) => s.peerDeviceId !== peerId),
                  session,
                ];
                historyRef.current.clear();
                creationRef.current.clear();
                liveRef.current.clear();
                sessionsRef.current = next;
                setSessions(next);
                void flushRef.current();
              }
              if (isUser && userPending) {
                clearTimeout(userPending.timer);
                // Keep the lease until human verification commits or cancels trust.
                userPairingsRef.current.delete(peerId);
                userPending.resolve(session);
              } else if (!isUser) {
                rehandshakePending?.finish();
                rehandshakePairingRef.current = null;
              }
            } catch (err) {
              manager.destroy();
              setSessions((prev) => {
                const next = prev.filter((s) => s.peerDeviceId !== peerId);
                historyRef.current.clear();
                creationRef.current.clear();
                liveRef.current.clear();
                sessionsRef.current = next;
                return next;
              });
              if (isUser && userPending) {
                clearTimeout(userPending.timer);
                userPending.finish();
                userPairingsRef.current.delete(peerId);
                userPending.reject(err instanceof Error ? err : new Error("Pairing failed"));
              } else if (!isUser) {
                rehandshakePending?.finish();
                rehandshakePairingRef.current = null;
              }
            }
          },
          onApprovalRequest: (req) => {
            try {
              addApproval(req);
              setPendingApprovals(getPending());
            } catch {
              // ignore duplicate or malformed
            }
          },
          onApprovalResult: (approvalId) => {
            void acknowledgeOperation(`approval-${approvalId}`);
          },
          onAgentStatus: (nextStatus) => {
            setAgentStatus(nextStatus);
          },
          onCloudSetup: (payload) => {
            const value = payload as Record<string, unknown>,
              trusted = trustedRef.current;
            const session = sessionsRef.current.find((s) => s.peerDeviceId === trusted?.deviceId);
            if (!value || !trusted || !session) return;
            if (value.action === "register" && value.deviceId === trusted.deviceId) {
              if (cloudSetupRef.current?.working && cloudSetupRef.current.session === session)
                return;
              cloudSetupRef.current = { session, working: true };
              setCloudError(null);
              void (async () => {
                let last: unknown;
                for (let attempt = 0; attempt < 3; attempt++) {
                  if (requireActiveAccount() !== owner || !sessionsRef.current.includes(session))
                    return;
                  try {
                    const grant = await registerPairedCloud(
                      value,
                      () =>
                        requireActiveAccount() === owner && sessionsRef.current.includes(session),
                    );
                    if (requireActiveAccount() !== owner || !sessionsRef.current.includes(session))
                      return;
                    if (cloudSetupRef.current?.session === session)
                      cloudSetupRef.current.relayUrl = grant.relayUrl;
                    encryptedSendRef.current(trusted.deviceId, "cloud_setup", {
                      ...grant,
                      action: "grant",
                    });
                    return;
                  } catch (e) {
                    last = e;
                    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
                  }
                }
                if (requireActiveAccount() === owner && sessionsRef.current.includes(session))
                  setCloudError(
                    last instanceof Error
                      ? last.message
                      : "Could not enable connection from anywhere",
                  );
              })().finally(() => {
                if (cloudSetupRef.current?.session === session)
                  cloudSetupRef.current.working = false;
              });
            } else if (
              value.action === "ready" &&
              typeof value.relayUrl === "string" &&
              value.relayUrl === cloudSetupRef.current?.relayUrl &&
              cloudSetupRef.current.session === session
            ) {
              const relayUrl = value.relayUrl as string;
              if (trusted.relayUrl !== relayUrl || trusted.lastWorking !== "cloud") {
                const updated = {
                  ...trusted,
                  relayUrl,
                  lanRelayUrl:
                    trusted.lanRelayUrl ??
                    (trusted.relayUrl.startsWith("ws:") ? trusted.relayUrl : undefined),
                  lastWorking: "cloud" as const,
                };
                trustedRef.current = updated;
                setTrustedDesktop(updated);
                void saveTrustedDesktop(updated).catch(() => {});
              }
              setCloudError(null);
              if (clientUrlRef.current !== relayUrl) connectRouteRef.current(relayUrl);
            } else if (value.action === "error")
              setCloudError(
                "Could not enable connection from anywhere. Local chat is still connected.",
              );
          },
          onWatchStatus: (payload) => liveRef.current.status(payload),
          onSessionUpdate: (payload) => liveRef.current.update(payload),
          onHistoryChunk: (payload) => historyRef.current.handle(payload),
          onSessionCreated: (value) => creationRef.current.handle(value),
          onWorkspaces: (workspaces, supported) => {
            setRemoteWorkspaces(workspaces);
            setCanCreateSessions(supported);
          },
          onSessionList: (validSessions) => {
            setRemoteSessions(validSessions);
          },
          onCommandResult: ({ idempotencyKey, status: cmdStatus, summary }) => {
            void acknowledgeOperation(idempotencyKey);
            setCommandLog((prev) =>
              prev.map((entry) =>
                entry.idempotencyKey === idempotencyKey
                  ? { ...entry, status: cmdStatus, summary }
                  : entry,
              ),
            );
          },
          onKillResult: (killAck) => {
            void acknowledgeOperation(killAck.idempotencyKey);
            setLastKillAck(killAck);
          },
          onChatToken: (token) => {
            const pending = pendingChatsRef.current.get(token.idempotencyKey);
            pending?.onToken?.(token.token, token.seq);
          },
          onChatDone: (done) => {
            void acknowledgeOperation(done.idempotencyKey);
            const pending = pendingChatsRef.current.get(done.idempotencyKey);
            if (pending) {
              clearTimeout(pending.timer);
              pendingChatsRef.current.delete(done.idempotencyKey);
              if (done.ok) {
                pending.resolve(done);
              } else {
                pending.reject(new Error(done.error ?? "Remote chat failed"));
              }
            }
          },
          onFileAccept: ({ transferId }) => {
            const pending = pendingFilesRef.current.get(transferId);
            pending?.onAccepted();
          },
          onFileReject: ({ transferId, reason }) => {
            const pending = pendingFilesRef.current.get(transferId);
            if (pending) {
              clearTimeout(pending.timer);
              pending.bytes.fill(0);
              pendingFilesRef.current.delete(transferId);
              pending.reject(new Error(reason || "File transfer rejected by desktop"));
            }
          },
          onFileReceived: ({ transferId, fileId }) => {
            const pending = pendingFilesRef.current.get(transferId);
            if (pending) {
              clearTimeout(pending.timer);
              pending.bytes.fill(0);
              pendingFilesRef.current.delete(transferId);
              pending.resolve(fileId);
            }
          },
          onFileError: ({ transferId, message }) => {
            const pending = pendingFilesRef.current.get(transferId);
            if (pending) {
              clearTimeout(pending.timer);
              pending.bytes.fill(0);
              pendingFilesRef.current.delete(transferId);
              pending.reject(new Error(message || "File transfer failed"));
            }
          },
        },
        authenticated,
      );
    },
    [getE2EState, owner],
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
        authorizeUrl: (url) =>
          authorizeRelayUrl(url, deviceIdRef.current, helloSignerRef.current!.pubkeyB64),
        deviceId: deviceIdRef.current,
        role: "mobile",
        wsImpl: ((): WsImpl => {
          if (typeof WebSocket === "undefined") {
            throw new Error("Global WebSocket is not available");
          }
          return relaySocketConstructor(
            WebSocket as unknown as NativeWebSocketConstructor,
            Platform.OS !== "web",
          );
        })(),
        helloSigner: helloSignerRef.current ?? undefined,
        onStatus: (s) => {
          statusRef.current = s;
          setStatus(s);
          if (s === "online") {
            clearTimeout(failoverRef.current);
            failoverRef.current = undefined;
          } else if (
            s === "reconnecting" &&
            !failoverRef.current &&
            trustedRef.current?.lanRelayUrl &&
            trustedRef.current.relayUrl.startsWith("wss:")
          ) {
            failoverRef.current = setTimeout(() => {
              failoverRef.current = undefined;
              const trusted = trustedRef.current;
              if (!trusted || statusRef.current === "online" || requireActiveAccount() !== owner)
                return;
              const alternative =
                clientUrlRef.current === trusted.relayUrl ? trusted.lanRelayUrl : trusted.relayUrl;
              if (alternative && alternative !== clientUrlRef.current)
                connectRouteRef.current(alternative);
            }, 2000);
          }
          if (s !== "online") {
            setRemoteWorkspaces([]);
            setCanCreateSessions(false);
            historyRef.current.clear();
            creationRef.current.clear();
            liveRef.current.clear();
            for (const session of sessionsRef.current) session.destroy?.();
            historyRef.current.clear();
            creationRef.current.clear();
            liveRef.current.clear();
            sessionsRef.current = [];
            setSessions([]);
            e2eStateRef.current.clear();
          } else if (trustedRef.current) recoverRef.current();
        },
        onMessage: (env) => handleIncoming(env),
      });
      clientRef.current = client;
      clientUrlRef.current = relayUrl;
      client.connect();
      return client;
    },
    [handleIncoming, owner],
  );

  useEffect(() => {
    let wasBackground = false;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") wasBackground = true;
      if (state !== "active" || !wasBackground) return;
      wasBackground = false;
      const trusted = trustedRef.current;
      if (!trusted || !aliveRef.current || !isActiveAccount(owner) || userScopeRef.current.busy)
        return;
      // iOS can suspend an apparently open socket across a network change.
      // Resume with a fresh transport/Noise baseline, using the existing pinned trust.
      clientRef.current?.close();
      clientRef.current = null;
      clientUrlRef.current = null;
      connectToRelay(
        trusted.lastWorking === "lan" && trusted.lanRelayUrl
          ? trusted.lanRelayUrl
          : trusted.relayUrl,
      );
    });
    return () => subscription.remove();
  }, [connectToRelay, owner]);

  const sendEncrypted = useCallback(
    (to: string, kind: MessageKind, payload: unknown): void => {
      if (!clientRef.current || statusRef.current !== "online") {
        throw new Error("Desktop channel is not ready");
      }
      const session = sessionsRef.current.find((s) => s.peerDeviceId === to);
      if (!session) {
        throw new Error(`sendEncrypted: no established session for peer ${to}`);
      }
      const state = getE2EState(to);
      const envelopeId = randomId();
      const outer = {
        id: envelopeId,
        from: deviceIdRef.current,
        to,
      };
      const ciphertext = seal(session, state, kind, payload, outer);
      const env: Envelope<"encrypted", EncryptedPayload> = {
        v: 2,
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

  connectRouteRef.current = connectToRelay;
  encryptedSendRef.current = sendEncrypted;

  const getSession = useCallback(
    (peerId: string): EstablishedSession | undefined => {
      return sessions.find((s) => s.peerDeviceId === peerId);
    },
    [sessions],
  );

  const watchConversation = useCallback(
    (
      id: string,
      onUpdate: (snapshot: RemoteConversation) => void,
      onError: (error: Error) => void,
      signal?: AbortSignal,
    ) => {
      const peer = trustedRef.current?.deviceId,
        session = sessions.find((s) => s.peerDeviceId === peer);
      if (!peer || !session || statusRef.current !== "online") {
        onError(new Error("Reconnecting to your Mac…"));
        return () => {};
      }
      return liveRef.current.watch(
        id,
        (kind, body) => {
          if (
            requireActiveAccount() !== owner ||
            trustedRef.current?.deviceId !== peer ||
            !sessionsRef.current.includes(session)
          )
            throw Error("Secure connection changed");
          sendEncrypted(peer, kind, body);
        },
        onUpdate,
        onError,
        signal,
      );
    },
    [owner, sendEncrypted, sessions],
  );

  const requestSessionHistory = useCallback(
    (id: string, signal?: AbortSignal) => {
      const peer = trustedRef.current?.deviceId;
      if (
        !peer ||
        statusRef.current !== "online" ||
        !sessionsRef.current.some((session) => session.peerDeviceId === peer)
      )
        return Promise.reject(new Error("Reconnect to your Mac before opening a conversation"));
      return historyRef.current.read(
        id,
        (request) => sendEncrypted(peer, "session_history_request", request),
        signal,
      );
    },
    [sendEncrypted],
  );

  const dropSession = useCallback(
    (peerDeviceId: string): void => {
      historyRef.current.clear();
      creationRef.current.clear();
      liveRef.current.clear();
      userScopeRef.current.cancel();
      recoveryScopeRef.current.cancel();
      prekeyLookupRef.current.destroy();
      rehandshakePairingRef.current?.manager.destroy();
      rehandshakePairingRef.current = null;
      candidatesRef.current.get(peerDeviceId)?.destroy?.();
      candidatesRef.current.delete(peerDeviceId);
      const pending = userPairingsRef.current.get(peerDeviceId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.manager.destroy();
        pending.finish();
        pending.reject(new Error("Pairing cancelled"));
        userPairingsRef.current.delete(peerDeviceId);
      }
      for (const session of sessionsRef.current)
        if (session.peerDeviceId === peerDeviceId) session.destroy?.();
      const next = sessionsRef.current.filter((session) => session.peerDeviceId !== peerDeviceId);
      historyRef.current.clear();
      creationRef.current.clear();
      liveRef.current.clear();
      sessionsRef.current = next;
      setSessions(next);
      const trusted = trustedRef.current;
      if (trusted) {
        rehandshakePairingRef.current = null;
        connectToRelay(
          trusted.lastWorking === "lan" && trusted.lanRelayUrl
            ? trusted.lanRelayUrl
            : trusted.relayUrl,
        );
        recoverRef.current();
      }
    },
    [connectToRelay],
  );

  const getEd25519PrivateKey = useCallback(async (): Promise<Uint8Array> => {
    let privB64 = await loadDeviceKey(BIMAX_ED25519_PRIV, owner);
    if (!privB64) {
      if (requireActiveAccount() !== owner) throw new Error("Account changed");
      await getOrCreateEd25519Keypair();
      privB64 = await loadDeviceKey(BIMAX_ED25519_PRIV, owner);
    }
    if (!privB64) {
      throw new Error("Failed to load or generate Ed25519 private key");
    }
    const key = base64ToBytes(privB64);
    if (!isActiveAccount(owner)) {
      key.fill(0);
      throw new Error("Account changed");
    }
    ownedPrivateKeys.current.add(key);
    return key;
  }, [owner]);

  const pairWithDesktop = useCallback(
    async (advert: PairingAdvertisement): Promise<EstablishedSession> => {
      const keypair = staticKeypairRef.current;
      const deviceId = deviceIdRef.current;
      if (!keypair || !deviceId) {
        return Promise.reject(new Error("Device identity not loaded yet"));
      }

      const lease = userScopeRef.current.begin();
      for (const candidate of candidatesRef.current.values()) candidate.destroy?.();
      candidatesRef.current.clear();
      recoveryScopeRef.current.cancel();
      rehandshakePairingRef.current?.manager.destroy();
      rehandshakePairingRef.current = null;
      for (const existing of userPairingsRef.current.values()) {
        clearTimeout(existing.timer);
        existing.manager.destroy();
        existing.reject(new Error("Superseded by a newer pairing attempt"));
      }
      userPairingsRef.current.clear();
      const attemptId = getNextAttemptId(advert.desktopDeviceId);
      const isCurrent = () => aliveRef.current && isActiveAccount(owner) && lease.isCurrent();

      let client: RelayClient;
      try {
        client = connectToRelay(advert.relayUrl);
      } catch (error) {
        lease.finish();
        throw error;
      }
      let signingKey: Uint8Array | undefined;
      let manager: PairingManager | undefined;
      let reqEnv: Envelope<"pairing_request", PairingRequest>;
      try {
        signingKey = await getEd25519PrivateKey();
        if (!isCurrent()) throw new Error("Pairing attempt was cancelled");
        manager = new PairingManager({
          deviceId,
          staticKeypair: keypair,
          helloKeypair: { privateKey: signingKey, publicKey: ed25519GetPublicKey(signingKey) },
        });
        const publicKey = isPqAdvertisement(advert)
          ? await prekeyLookupRef.current.fetch(advert, deviceId, (env) => client.send(env))
          : undefined;
        if (!isCurrent()) throw new Error("Pairing attempt was cancelled");
        reqEnv = manager.beginPairing(advert, publicKey);
      } catch (err) {
        manager?.destroy();
        lease.finish();
        return Promise.reject(err instanceof Error ? err : new Error("beginPairing failed"));
      } finally {
        signingKey?.fill(0);
        if (signingKey) ownedPrivateKeys.current.delete(signingKey);
      }
      if (!manager) {
        lease.finish();
        throw new Error("Pairing manager initialization failed");
      }
      const pendingManager = manager;
      const retryTimer = setInterval(() => {
        if (isCurrent() && clientRef.current === client && statusRef.current === "online") {
          try {
            client.send(reqEnv);
          } catch {
            /* deadline handles a disconnected socket */
          }
        }
      }, 2000);
      return new Promise<EstablishedSession>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (userPairingsRef.current.get(advert.desktopDeviceId)?.attemptId === attemptId)
            userPairingsRef.current.delete(advert.desktopDeviceId);
          lease.finish();
          pendingManager.destroy();
          reject(new Error(pairingTimeout(statusRef.current)));
        }, 60000);
        userPairingsRef.current.set(advert.desktopDeviceId, {
          manager: pendingManager,
          resolve,
          reject,
          timer,
          attemptId,
          isCurrent,
          finish: lease.finish,
        });
        try {
          client.send(reqEnv);
        } catch (error) {
          clearTimeout(timer);
          pendingManager.destroy();
          lease.finish();
          if (userPairingsRef.current.get(advert.desktopDeviceId)?.attemptId === attemptId)
            userPairingsRef.current.delete(advert.desktopDeviceId);
          reject(error instanceof Error ? error : new Error("Pairing send failed"));
        }
      }).finally(() => clearInterval(retryTimer));
    },
    [connectToRelay, getNextAttemptId, getEd25519PrivateKey, owner],
  );

  const refreshTrustedDesktop = useCallback(
    async (verified: EstablishedSession): Promise<void> => {
      if (
        !userScopeRef.current.busy ||
        candidatesRef.current.get(verified.peerDeviceId) !== verified
      )
        throw new Error("Verified pairing was cancelled or superseded");
      const isCurrent = userScopeRef.current.capture();
      // A trust commit must fail closed, including when SecureStore read-back fails.
      recoveryScopeRef.current.cancel();
      rehandshakePairingRef.current?.manager.destroy();
      rehandshakePairingRef.current = null;
      trustedRef.current = null;
      setTrustedDesktop(null);
      for (const session of sessionsRef.current) session.destroy?.();
      historyRef.current.clear();
      creationRef.current.clear();
      liveRef.current.clear();
      sessionsRef.current = [];
      setSessions([]);
      try {
        const trusted = await loadTrustedDesktop();
        if (
          !aliveRef.current ||
          !isActiveAccount(owner) ||
          !isCurrent() ||
          candidatesRef.current.get(verified.peerDeviceId) !== verified
        )
          throw new Error("Pairing was cancelled or superseded while loading trust");
        if (!trusted || !matchesDesktopSession(trusted, verified))
          throw new Error("Verified session does not match saved desktop trust");
        trustedRef.current = trusted;
        setTrustedDesktop(trusted);
        userScopeRef.current.cancel();
        candidatesRef.current.delete(verified.peerDeviceId);
        historyRef.current.clear();
        creationRef.current.clear();
        liveRef.current.clear();
        sessionsRef.current = [verified];
        setSessions([verified]);
        void flushRef.current();
      } catch (error) {
        if (isCurrent()) {
          userScopeRef.current.cancel();
          for (const candidate of candidatesRef.current.values()) candidate.destroy?.();
          candidatesRef.current.clear();
        }
        throw error;
      }
    },
    [owner],
  );

  const {
    sendInstruction,
    sendRemoteChat,
    sendRemoteFile,
    requestSessionList,
    sendKill,
    approve,
    deny,
  } = useRemoteActions({
    owner,
    trustedRef,
    statusRef,
    sessionsRef,
    ownedPrivateKeys,
    pendingChatsRef,
    pendingFilesRef,
    pendingApprovals,
    setPendingApprovals,
    setCommandLog,
    setLastKillAck,
    sendEncrypted,
    getEd25519PrivateKey,
  });

  flushRef.current = async () => {
    if (requireActiveAccount() !== owner) return;
    const peer = trustedRef.current?.deviceId;
    if (
      !peer ||
      statusRef.current !== "online" ||
      !sessionsRef.current.some((s) => s.peerDeviceId === peer)
    )
      return;
    if (Date.now() - lastFlushRef.current < 2000) return;
    lastFlushRef.current = Date.now();
    for (const operation of (await pendingOperations(peer)).slice(0, 8)) {
      if (operation.expiresAt > Date.now()) sendEncrypted(peer, operation.kind, operation.body);
    }
  };
  recoverRef.current = () => {
    const trusted = trustedRef.current,
      keypair = staticKeypairRef.current;
    if (
      !trusted ||
      !keypair ||
      statusRef.current !== "online" ||
      userPairingsRef.current.has(trusted.deviceId)
    )
      return;
    const pending = rehandshakePairingRef.current;
    if (pending) {
      if (!pending.isCurrent()) {
        pending.manager.destroy();
        pending.finish();
        rehandshakePairingRef.current = null;
        return;
      }
      if (Date.now() - pending.startedAt >= 25_000) {
        pending.manager.destroy();
        pending.finish();
        rehandshakePairingRef.current = null;
        if (trusted.cryptoVersion === 2)
          setConnectionError("Secure reconnect expired. Scan a fresh desktop QR code.");
      } else {
        try {
          clientRef.current?.send(pending.request);
        } catch {
          /* retry on the next online tick */
        }
      }
      return;
    }
    if (sessionsRef.current.some((s) => s.peerDeviceId === trusted.deviceId)) return;
    if (userScopeRef.current.busy || recoveryScopeRef.current.busy) return;
    const lease = recoveryScopeRef.current.begin();
    const isCurrent = () =>
      aliveRef.current &&
      isActiveAccount(owner) &&
      lease.isCurrent() &&
      sameDesktopTrust(trustedRef.current, trusted);
    void (async () => {
      let privateKey: Uint8Array | undefined;
      let signedManager: PairingManager | undefined;
      try {
        privateKey = await getEd25519PrivateKey();
        if (!isCurrent() || statusRef.current !== "online" || rehandshakePairingRef.current) {
          lease.finish();
          return;
        }
        const pqAdvert = trusted.nextPqPrekey?.advertisement ?? trusted.nextPqAdvertisement;
        if (trusted.cryptoVersion === 2 && !pqAdvert)
          throw new Error("Secure reconnect needs a fresh desktop QR code.");
        const pqPublicKey =
          trusted.nextPqPrekey?.publicKey ??
          (pqAdvert
            ? await prekeyLookupRef.current.fetch(pqAdvert, deviceIdRef.current, (env) =>
                clientRef.current!.send(env),
              )
            : undefined);
        if (!isCurrent() || statusRef.current !== "online" || rehandshakePairingRef.current) {
          lease.finish();
          return;
        }
        signedManager = new PairingManager({
          deviceId: deviceIdRef.current,
          staticKeypair: keypair,
          helloKeypair: { privateKey, publicKey: ed25519GetPublicKey(privateKey) },
        });
        const request = signedManager.beginPairing(
          pqAdvert ?? {
            relayUrl: clientUrlRef.current!,
            ref: "rehandshake",
            desktopDeviceId: trusted.deviceId,
            desktopPublicKey: trusted.staticPublicKeyB64,
            app: "bimax",
          },
          pqPublicKey,
        );
        rehandshakePairingRef.current = {
          attemptId: getNextAttemptId(trusted.deviceId),
          manager: signedManager,
          request,
          startedAt: Date.now(),
          isCurrent,
          finish: lease.finish,
        };
        clientRef.current?.send(request);
      } catch (error) {
        const report = isCurrent();
        lease.finish();
        signedManager?.destroy();
        if (rehandshakePairingRef.current?.manager === signedManager)
          rehandshakePairingRef.current = null;
        if (report)
          setConnectionError(
            error instanceof Error
              ? error.message
              : "Secure reconnect failed. Scan a fresh desktop QR code.",
          );
      } finally {
        privateKey?.fill(0);
        if (privateKey) ownedPrivateKeys.current.delete(privateKey);
      }
    })().catch(() => {});
  };
  useEffect(() => {
    aliveRef.current = true;
    let isMounted = true;
    let signingPrivate: Uint8Array | null = null;
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
        if (!isMounted) {
          edPrivKey.fill(0);
          return;
        }
        signingPrivate = edPrivKey;
        const edPubBytes = ed25519GetPublicKey(edPrivKey);
        const edPubkeyB64 = bytesToBase64(edPubBytes);
        helloSignerRef.current = {
          pubkeyB64: edPubkeyB64,
          sign: async (msg: Uint8Array) => ed25519Sign(edPrivKey, msg),
        };

        const trusted = await loadTrustedDesktop();
        if (!isMounted || userScopeRef.current.busy) return;
        trustedRef.current = trusted;
        setTrustedDesktop(trusted);
        if (!trusted) {
          statusRef.current = "idle";
          setStatus("idle");
          return;
        }

        const probeResult = await probeTrustedRelay({
          trusted,
          connectToRelay,
          isOnline: () => statusRef.current === "online",
          isMounted: () => isMounted,
        });

        if (!isMounted) return;

        if (probeResult) {
          if (!sameDesktopTrust(trustedRef.current, trusted)) return;
          const { lastWorking } = probeResult;
          // A fast reconnect may already have authenticated a newer one-time prekey.
          const updatedTrusted = { ...(trustedRef.current ?? trusted), lastWorking };
          trustedRef.current = updatedTrusted;
          setTrustedDesktop(updatedTrusted);
          try {
            await saveTrustedDesktop(updatedTrusted);
          } catch {
            // ignore save error
          }

          recoverRef.current();
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
      } catch (error) {
        if (isMounted) {
          setConnectionError(
            error instanceof Error ? error.message : "Could not connect to desktop",
          );
          statusRef.current = "idle";
          setStatus("idle");
          setTrustedDesktop(null);
        }
      }
    }
    const prekeyLookup = prekeyLookupRef.current;
    const userScope = userScopeRef.current;
    const recoveryScope = recoveryScopeRef.current;
    const userPairings = userPairingsRef.current;
    const pendingChats = pendingChatsRef.current;
    const pendingFiles = pendingFilesRef.current;
    const privateKeys = ownedPrivateKeys.current;
    const candidates = candidatesRef.current;
    const e2eStates = e2eStateRef.current;
    const history = historyRef.current;
    const creation = creationRef.current;
    const live = liveRef.current;
    init();
    return () => {
      isMounted = false;
      clearTimeout(failoverRef.current);
      failoverRef.current = undefined;
      aliveRef.current = false;
      userScope.cancel();
      recoveryScope.cancel();
      for (const [, p] of userPairings) {
        clearTimeout(p.timer);
        p.manager.destroy();
        p.reject(new Error("Provider unmounted"));
      }
      userPairings.clear();
      for (const [, chat] of pendingChats) {
        clearTimeout(chat.timer);
        chat.reject(new Error("Provider unmounted"));
      }
      pendingChats.clear();
      for (const [, file] of pendingFiles) {
        clearTimeout(file.timer);
        file.bytes.fill(0);
        file.reject(new Error("Provider unmounted"));
      }
      pendingFiles.clear();
      staticKeypairRef.current?.privateKey.fill(0);
      staticKeypairRef.current = null;
      signingPrivate?.fill(0);
      for (const key of privateKeys) key.fill(0);
      privateKeys.clear();
      for (const session of sessionsRef.current) session.destroy?.();
      for (const session of candidates.values()) session.destroy?.();
      prekeyLookup.destroy();
      rehandshakePairingRef.current?.manager.destroy();
      candidates.clear();
      history.clear();
      creation.clear();
      live.clear();
      e2eStates.clear();
      helloSignerRef.current = null;
      sessionsRef.current = [];
      rehandshakePairingRef.current = null;
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
  }, [connectToRelay, getNextAttemptId, getEd25519PrivateKey]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (statusRef.current === "online") {
        recoverRef.current();
        void flushRef.current().catch(() => {});
        const peer = trustedRef.current?.deviceId;
        if (peer && sessionsRef.current.some((s) => s.peerDeviceId === peer)) {
          try {
            sendEncrypted(peer, "session_list_request", {});
          } catch {
            /* reconnect will retry */
          }
        }
      }
    }, 10_000);
    return () => clearInterval(timer);
  }, [sendEncrypted]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (rehandshakePairingRef.current) recoverRef.current();
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const expired = sessionsRef.current.some(
        (session) =>
          Date.now() - session.establishedAt >= 25 * 60_000 || session.needsRehandshake?.(),
      );
      if (!expired) return;
      for (const session of sessionsRef.current) session.destroy?.();
      historyRef.current.clear();
      creationRef.current.clear();
      liveRef.current.clear();
      sessionsRef.current = [];
      setSessions([]);
      recoverRef.current();
    }, 30_000);
    return () => clearInterval(timer);
  }, []);
  const createMacSession = useCallback(
    (workspaceId: string, requestId: string, signal?: AbortSignal) => {
      const peer = trustedRef.current?.deviceId;
      if (
        !peer ||
        !isActiveAccount(owner) ||
        !sessionsRef.current.some((s) => s.peerDeviceId === peer)
      )
        return Promise.reject(Error("Connect to your Mac first"));
      return creationRef.current.create(
        requestId,
        workspaceId,
        (request) => sendEncrypted(peer, "session_create_request", request),
        signal,
      );
    },
    [owner, sendEncrypted],
  );
  const value: RelayContextValue = {
    status,
    connectionError,
    connectionRoute:
      status === "online" && sessions.some((s) => s.peerDeviceId === trustedDesktop?.deviceId)
        ? clientUrlRef.current?.startsWith("wss:")
          ? "cloud"
          : "lan"
        : "none",
    cloudError,
    retryCloud: () => {
      const peer = trustedRef.current?.deviceId;
      if (peer) {
        setCloudError(null);
        try {
          sendEncrypted(peer, "cloud_setup", { action: "request" });
        } catch {
          setCloudError("Reconnect to your Mac to enable access from anywhere");
        }
      }
    },
    trustedDesktop,
    refreshTrustedDesktop,
    sessions,
    getSession,
    dropSession,
    pendingApprovals,
    approve,
    deny,
    sendEncrypted,
    pairWithDesktop,
    agentStatus,
    remoteSessions,
    remoteWorkspaces,
    canCreateSessions,
    createMacSession,
    commandLog,
    sendInstruction,
    sendRemoteChat,
    sendRemoteFile,
    requestSessionList,
    requestSessionHistory,
    watchConversation,
    sendKill,
    lastKillAck,
  };

  return <RelayContext.Provider value={value}>{children}</RelayContext.Provider>;
}
