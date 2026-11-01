import { useCallback, type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import {confirmPhoneDecision} from "../approvals/device-auth";
import type {
  MessageKind,
  ToolApprovalRequest,
  CommandRequest,
  KillRequest,
  KillResult,
  ChatMessage,
  ChatDone,
  FileOffer,
  FileChunk,
  FileDone,
} from "@bimax/protocol";
import { randomId, sha256Bytes, secureRandomBytes } from "../crypto/keys";
import { bytesToBase64, type TrustedDesktop } from "../crypto";
import { requireActiveAccount } from "../account-scope";
import { enqueueOperation } from "../operation-outbox";
import {
  getPending,
  removeApproval,
  buildApprovalDecision,
  signApprovalDecision,
  decideWithBiometric,
} from "../approvals";
import type { EstablishedSession } from "./session";
import type { ClientStatus } from "../relay/client";
import type {
  CommandLogEntry,
  RemoteChatOptions,
  RemoteFileInput,
  PendingRemoteChat,
  PendingFileTransfer,
} from "./provider";

const FILE_CHUNK_BYTES = 32 * 1024;

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  }
  return hex;
}

export interface UseRemoteActionsParams {
  owner: string;
  trustedRef: MutableRefObject<TrustedDesktop | null>;
  statusRef: MutableRefObject<ClientStatus | "idle">;
  sessionsRef: MutableRefObject<EstablishedSession[]>;
  ownedPrivateKeys: MutableRefObject<Set<Uint8Array>>;
  pendingChatsRef: MutableRefObject<Map<string, PendingRemoteChat>>;
  pendingFilesRef: MutableRefObject<Map<string, PendingFileTransfer>>;
  pendingApprovals: ToolApprovalRequest[];
  setPendingApprovals: Dispatch<SetStateAction<ToolApprovalRequest[]>>;
  setCommandLog: Dispatch<SetStateAction<CommandLogEntry[]>>;
  setLastKillAck: Dispatch<SetStateAction<KillResult | null>>;
  sendEncrypted: (to: string, kind: MessageKind, payload: unknown) => void;
  getEd25519PrivateKey: () => Promise<Uint8Array>;
}

export function useRemoteActions({
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
}: UseRemoteActionsParams) {
  const requireDesktopId = useCallback((): string => {
    const desktopId = trustedRef.current?.deviceId;
    if (!desktopId) {
      throw new Error("No trusted desktop configured");
    }
    return desktopId;
  }, [trustedRef]);

  const sendInstruction = useCallback(
    async (instruction: string): Promise<void> => {
      const trimmed = instruction.trim();
      if (trimmed.length === 0) {
        throw new Error("Instruction cannot be empty");
      }
      if (trimmed.length > 4000) {
        throw new Error("Instruction exceeds maximum length of 4000 characters");
      }

      const desktopId = requireDesktopId();
      const idempotencyKey = randomId("cmd");
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
        await enqueueOperation({
          id: idempotencyKey,
          peer: desktopId,
          kind: "command_request",
          body: req,
          expiresAt: now + 120_000,
        });
        if (
          statusRef.current === "online" &&
          sessionsRef.current.some((s) => s.peerDeviceId === desktopId)
        ) {
          sendEncrypted(desktopId, "command_request", req);
        }
      } catch (err) {
        setCommandLog((prev) =>
          prev.map((e) =>
            e.idempotencyKey === idempotencyKey
              ? {
                  ...e,
                  status: "failed",
                  summary: err instanceof Error ? err.message : "Send failed",
                }
              : e,
          ),
        );
        throw err;
      }
    },
    [requireDesktopId, sendEncrypted, setCommandLog, sessionsRef, statusRef],
  );

  const sendRemoteChat = useCallback(
    async (options: RemoteChatOptions): Promise<ChatDone> => {
      const desktopId = requireDesktopId();
      if (requireActiveAccount() !== owner) throw new Error("Account changed");
      const trimmed = options.text.trim();
      if (!trimmed && (!options.fileIds || options.fileIds.length === 0)) {
        throw new Error("Chat message requires text or attached files");
      }
      const idempotencyKey = randomId("chat");
      const now = Date.now();
      const msg: ChatMessage = {
        idempotencyKey,
        sessionId: options.sessionId,
        text: options.text,
        fileIds: options.fileIds,
        sentAt: now,
      };

      await enqueueOperation({
        id: idempotencyKey,
        peer: desktopId,
        kind: "chat_message",
        body: msg,
        expiresAt: now + 120_000,
      });

      if (requireActiveAccount() !== owner || trustedRef.current?.deviceId !== desktopId)
        throw new Error("Account or paired Mac changed");

      return new Promise<ChatDone>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingChatsRef.current.delete(idempotencyKey);
          reject(new Error("Remote chat timed out waiting for desktop response"));
        }, 120_000);
        pendingChatsRef.current.set(idempotencyKey, {
          onToken: options.onToken,
          resolve,
          reject,
          timer,
        });
        if (
          statusRef.current === "online" &&
          sessionsRef.current.some((s) => s.peerDeviceId === desktopId)
        ) {
          try {
            sendEncrypted(desktopId, "chat_message", msg);
          } catch (err) {
            clearTimeout(timer);
            pendingChatsRef.current.delete(idempotencyKey);
            reject(err instanceof Error ? err : new Error("Failed to send remote chat"));
          }
        }
      });
    },
    [owner, requireDesktopId, sendEncrypted, pendingChatsRef, sessionsRef, statusRef, trustedRef],
  );

  const sendRemoteFile = useCallback(
    async (file: RemoteFileInput): Promise<string> => {
      const desktopId = requireDesktopId();
      if (file.bytes.length === 0 || file.bytes.length > 25 * 1024 * 1024) {
        throw new Error("File size must be between 1 byte and 25 MB");
      }
      const transferId = bytesToHex(secureRandomBytes(16));
      const sha256 = bytesToHex(sha256Bytes(file.bytes));
      const copy = new Uint8Array(file.bytes);
      const offer: FileOffer = {
        transferId,
        name: file.name.slice(0, 255),
        mime: file.mime,
        sizeBytes: copy.length,
        sha256,
      };

      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          copy.fill(0);
          pendingFilesRef.current.delete(transferId);
          reject(new Error("File transfer timed out"));
        }, 120_000);

        pendingFilesRef.current.set(transferId, {
          bytes: copy,
          onAccepted: () => {
            try {
              let seq = 0;
              for (let offset = 0; offset < copy.length; offset += FILE_CHUNK_BYTES) {
                const slice = copy.subarray(
                  offset,
                  Math.min(offset + FILE_CHUNK_BYTES, copy.length),
                );
                const chunk: FileChunk = {
                  transferId,
                  seq: seq++,
                  data: bytesToBase64(slice),
                };
                sendEncrypted(desktopId, "file_chunk", chunk);
              }
              const done: FileDone = { transferId };
              sendEncrypted(desktopId, "file_done", done);
            } catch (err) {
              clearTimeout(timer);
              copy.fill(0);
              pendingFilesRef.current.delete(transferId);
              reject(err instanceof Error ? err : new Error("Failed to stream file chunks"));
            }
          },
          resolve,
          reject,
          timer,
        });

        try {
          sendEncrypted(desktopId, "file_offer", offer);
        } catch (err) {
          clearTimeout(timer);
          copy.fill(0);
          pendingFilesRef.current.delete(transferId);
          reject(err instanceof Error ? err : new Error("Failed to send file offer"));
        }
      });
    },
    [requireDesktopId, sendEncrypted, pendingFilesRef],
  );

  const requestSessionList = useCallback((): void => {
    const desktopId = requireDesktopId();
    sendEncrypted(desktopId, "session_list_request", {});
  }, [requireDesktopId, sendEncrypted]);

  const sendKill = useCallback(
    async (reason?: string): Promise<void> => {
      const desktopId = requireDesktopId();
      const idempotencyKey = randomId("kill");
      const req: KillRequest = {
        idempotencyKey,
        reason,
        sentAt: Date.now(),
      };
      setLastKillAck(null);
      await enqueueOperation({
        id: idempotencyKey,
        peer: desktopId,
        kind: "kill_request",
        body: req,
        expiresAt: req.sentAt + 30_000,
      });
      if (
        statusRef.current === "online" &&
        sessionsRef.current.some((s) => s.peerDeviceId === desktopId)
      ) {
        sendEncrypted(desktopId, "kill_request", req);
      }
    },
    [requireDesktopId, sendEncrypted, setLastKillAck, sessionsRef, statusRef],
  );

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
          return confirmPhoneDecision(`Approve ${req.tool}?`);
        },
        build: () => buildApprovalDecision(req, "approved"),
        sign: (unsigned) => ({ ...unsigned, signature: "" }),
        onDecision: async (dec) => {
          if (requireActiveAccount() !== owner || req.expiresAt <= Date.now())
            throw new Error("Approval expired or account changed");
          const privKey = await getEd25519PrivateKey();
          const { signature: _sig, ...unsigned } = dec;
          const signed = signApprovalDecision(unsigned, privKey);
          privKey.fill(0);
          ownedPrivateKeys.current.delete(privKey);
          await enqueueOperation({
            id: `approval-${approvalId}`,
            peer: desktopId,
            kind: "approval_decision",
            body: signed,
            expiresAt: req.expiresAt,
          });
          if (
            statusRef.current === "online" &&
            sessionsRef.current.some((session) => session.peerDeviceId === desktopId)
          ) {
            sendEncrypted(desktopId, "approval_decision", signed);
          }
          removeApproval(approvalId);
          setPendingApprovals(getPending());
        },
        onDenied: (reason) => {
          throw new Error(`Biometric authentication failed: ${reason}`);
        },
      });
    },
    [
      pendingApprovals,
      sendEncrypted,
      getEd25519PrivateKey,
      owner,
      ownedPrivateKeys,
      sessionsRef,
      setPendingApprovals,
      statusRef,
      trustedRef,
    ],
  );

  const deny = useCallback(
    async (approvalId: string, reason?: "not_me" | "mistake"): Promise<void> => {
      const req = pendingApprovals.find((a) => a.approvalId === approvalId);
      if (!req) {
        throw new Error(`Approval request ${approvalId} not found`);
      }
      const desktopId = trustedRef.current?.deviceId;
      if (!desktopId) {
        throw new Error("No trusted desktop configured for approvals");
      }

      const authenticated = await confirmPhoneDecision(`Deny ${req.tool}?`);
      if (!authenticated || requireActiveAccount() !== owner) throw new Error("Authentication required");
      const privKey = await getEd25519PrivateKey();
      const unsigned = buildApprovalDecision(req, "denied", reason);
      const signed = signApprovalDecision(unsigned, privKey);
      privKey.fill(0);
      ownedPrivateKeys.current.delete(privKey);
      if (req.expiresAt <= Date.now()) throw new Error("Approval expired");
      await enqueueOperation({
        id: `approval-${approvalId}`,
        peer: desktopId,
        kind: "approval_decision",
        body: signed,
        expiresAt: req.expiresAt,
      });
      if (
        statusRef.current === "online" &&
        sessionsRef.current.some((session) => session.peerDeviceId === desktopId)
      ) {
        sendEncrypted(desktopId, "approval_decision", signed);
      }
      removeApproval(approvalId);
      setPendingApprovals(getPending());
    },
    [
      pendingApprovals,
      sendEncrypted,
      getEd25519PrivateKey,
      owner,
      ownedPrivateKeys,
      sessionsRef,
      setPendingApprovals,
      statusRef,
      trustedRef,
    ],
  );

  return {
    sendInstruction,
    sendRemoteChat,
    sendRemoteFile,
    requestSessionList,
    sendKill,
    approve,
    deny,
  };
}
