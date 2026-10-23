/** Protocol 2: breaking upgrade; reject v1 peers. Transcript-bound signing identity, explicit transport nonces, and fver 2 are required. */
/**
 * @bimax/protocol v1.7 — wire protocol between the Bimax desktop engine
 * and the mobile companion app.
 *
 * PURE TYPES ONLY. No runtime code, no dependencies.
 * This package is owned by the architect. Do not edit without approval.
 *
 * v1.7 (2026-10-13, additive): MessageKind gains chat_message, chat_token,
 * chat_done, file_offer, file_accept, file_reject, file_chunk, file_done,
 * file_received, file_error; new payload interfaces ChatMessage, ChatToken,
 * ChatDone, FileOffer, FileAccept, FileReject, FileChunk, FileDone,
 * FileReceived, FileError.
 *
 * v1.6 (2026-10-13, additive): ApprovalDecision gains required `requestHash`
 * (base64 SHA-256 over the canonical JSON bytes of the ToolApprovalRequest
 * the user saw), binding the signed decision to the exact request content.
 *
 * v1.5 (2026-10-13, additive): authenticated DeviceHello (helloPubkey, helloSignature)
 * with TOFU pin semantics; PairingAdvertisement gains optional lanRelayUrl;
 * KillRequest gains required idempotencyKey; MessageKind gains "kill_result"
 * carrying KillResult payload.
 *
 * v1.4 (2026-10-12, additive): remote-control surface message kinds (agent_status,
 * session_list_request, command_request, command_result, kill_request) and
 * payload interfaces (AgentStatus, AgentSessionInfo, SessionList, CommandRequest,
 * CommandResult, KillRequest).
 *
 * v1.3 (2026-10-12, additive): MessageKind gains "encrypted"; new EncryptedPayload
 * carries base64 SealedFrame ciphertext encrypted with Noise transport keys.
 *
 * v1.2 (2026-10-12, additive): PairingRequest gains required `handshakeMessage`
 * (base64 Noise handshake message 1); PairingGrant gains required
 * `handshakeMessage` (base64 Noise handshake message 2).
 *
 * v1.1 (2026-10-12, additive): Envelope gains required `to` (the relay
 * routes every message point-to-point); new MessageKind union of all known
 * kinds; new DeviceHello (first message on every websocket connection);
 * new DeliveryAck (client acks each drained outbox message so the relay
 * can delete it).
 */

export const PROTOCOL_VERSION = 2 as const;

/* ---------------- message kinds ---------------- */

export type MessageKind =
  | "hello"
  | "presence"
  | "session_list"
  | "transcript_chunk"
  | "approval_request"
  | "approval_decision"
  | "approval_result"
  | "mobile_command"
  | "command_ack"
  | "pairing_request"
  | "pairing_grant"
  | "pairing_prekey_request"
  | "pairing_prekey"
  | "pairing_revoke"
  | "delivery_ack"
  | "encrypted"
  | "agent_status"
  | "session_list_request"
  | "command_request"
  | "command_result"
  | "kill_request"
  | "kill_result"
  | "chat_message"
  | "chat_token"
  | "chat_done"
  | "file_offer"
  | "file_accept"
  | "file_reject"
  | "file_chunk"
  | "file_done"
  | "file_received"
  | "file_error"
  | "error";

/* ---------------- transport envelope ---------------- */

export type DeviceRole = "desktop" | "mobile";

export interface Envelope<TKind extends string = MessageKind, TPayload = unknown> {
  v: typeof PROTOCOL_VERSION; // protocol version
  id: string; // client-generated stable id — idempotency key for retries
  ts: number; // unix millis, sender clock
  from: string; // sender device id (public identifier)
  to: string; // recipient device id ("relay" for hello)
  kind: TKind; // message kind
  payload: TPayload;
}

/* ---------------- encrypted envelopes ---------------- */

export interface EncryptedPayload {
  ciphertext: string; // base64: SealedFrame encrypted with the Noise transport key
}

/* ---------------- remote control: status, sessions, commands, kill ---------------- */

export type AgentState = "idle" | "working" | "waiting_approval" | "error";

export interface AgentStatus {
  state: AgentState;
  sessionId?: string;
  taskSummary?: string; // short human-readable summary, never secrets
  updatedAt: number;
}

export interface AgentSessionInfo {
  sessionId: string;
  title: string;
  status: AgentState;
  startedAt: number;
}

export interface SessionList {
  sessions: AgentSessionInfo[];
}

export interface CommandRequest {
  instruction: string;
  idempotencyKey: string; // phone-generated; desktop dedupes on this
  sentAt: number;
}

export interface CommandResult {
  idempotencyKey: string;
  ok: boolean;
  summary: string; // short result summary, never secrets
}

export interface KillRequest {
  idempotencyKey: string;
  reason?: string;
  sentAt: number;
}

export interface KillResult {
  idempotencyKey: string;
  ok: boolean;
  detail?: string;
  at: number;
}

/* ---------------- hello (first message on every connection) ---------------- */

/**
 * TOFU — pin `helloPubkey` per `deviceId` on first hello; on later hellos,
 * reject when the pubkey differs (possible squat) or the signature is invalid
 * or `|now - ts| > 120000` ms (replay window).
 */
export interface DeviceHello {
  deviceId: string;
  role: DeviceRole;
  protocolVersion: number; // must equal PROTOCOL_VERSION, else the relay drops the socket
  helloPubkey: string; // base64 Ed25519 device public key (the approval-signing key)
  helloSignature: string; // base64 Ed25519 signature over the canonical JSON bytes of
  // { id, ts, from, deviceId, role, helloPubkey, protocolVersion }
  // where id/ts/from are the hello envelope's own fields
}

/* ---------------- delivery acks ---------------- */

export interface DeliveryAck {
  id: string; // envelope id being acknowledged
  fromDevice?: string; // original sender; required to disambiguate equal IDs across senders
}

/* ---------------- pairing ---------------- */

export interface PairingAdvertisement {
  // Encoded in the QR code shown by the desktop app. `ref` rotates ~20s.
  relayUrl: string;
  lanRelayUrl?: string; // e.g. ws://192.168.1.5:8787; absent when the desktop has no LAN relay
  ref: string;
  desktopDeviceId: string;
  desktopPublicKey: string; // base64 X25519
  app: "bimax";
  /** Absent for classical IK. A scanned v2 advertisement MUST NOT fall back. */
  cryptoVersion?: 2;
  suite?: "PQIK_MLKEM768_IKPSK0_25519_CHACHAPOLY_BLAKE2S";
  pqPrekeyId?: string;
  pqPrekeyHash?: string; // base64 SHA-256 of the 1184-byte encapsulation key
  expiresAt?: number;
}

export interface PairingPrekeyRequest {
  ref: string;
  pqPrekeyId: string;
}

export interface PairingPrekey {
  requestId?: string; // correlates an unauthenticated public-key lookup response
  advertisement: PairingAdvertisement;
  publicKey: string; // base64 ML-KEM-768 encapsulation key; verify QR commitment
}

export interface PairingRequest {
  ref: string;
  mobileDeviceId: string;
  mobilePublicKey?: string; // Classical compatibility only; PQ identity stays inside Noise M1.
  handshakeMessage: string; // base64 Noise handshake message 1
  cryptoVersion?: 2;
  pqPrekeyId?: string;
  kemCiphertext?: string; // base64 ML-KEM-768 ciphertext, exactly 1088 bytes
}

export interface PairingGrant {
  mobileDeviceId: string;
  grantedAt: number;
  handshakeMessage: string; // base64 Noise handshake message 2
  handshakeId?: string; // SHA-256 of Noise M1, also authenticated inside M2; required for PQ.
}

export interface PairingRevoke {
  mobileDeviceId: string;
  revokedAt: number;
  reason: string;
}

/* ---------------- presence ---------------- */

export type PresenceStatus = "online" | "away" | "offline";

export interface Presence {
  deviceId: string;
  role: DeviceRole;
  status: PresenceStatus;
  lastSeen: number; // unix millis
}

/* ---------------- sessions ---------------- */

export type SessionStatus =
  "running" | "paused" | "awaiting_approval" | "done" | "failed" | "killed";

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
  repo?: string;
}

export type TranscriptRole = "user" | "assistant" | "tool";

export interface TranscriptChunk {
  sessionId: string;
  seq: number; // per-session sequence; client buffers and orders by seq
  role: TranscriptRole;
  text: string;
  at: number;
}

/* ---------------- tool approvals ---------------- */

export interface ToolApprovalRequest {
  approvalId: string; // idempotency key for the decision
  sessionId: string;
  tool: string; // e.g. "OS_COMMAND"
  summary: string; // human-readable: what it wants to do
  detail: string; // full command / arguments
  cwd?: string;
  requestedAt: number;
  expiresAt: number; // expiry => treated as denied
}

export type ApprovalDecisionValue = "approved" | "denied";

export interface ApprovalDecision {
  approvalId: string;
  sessionId: string;
  decision: ApprovalDecisionValue;
  decidedAt: number;
  denyReason?: "not_me" | "mistake"; // "not_me" raises a security alert
  requestHash: string; // base64 SHA-256 over the canonical JSON bytes of the
  // ToolApprovalRequest the user saw; the desktop MUST
  // recompute it from its stored request and reject on
  // mismatch BEFORE acting on the decision
  signature: string; // base64 Ed25519 over canonical bytes of everything above; desktop verifies
}

/* ---------------- commands: mobile -> desktop ---------------- */

export type MobileCommandKind =
  "send_message" | "pause" | "resume" | "kill" | "request_approval_list";

export interface MobileCommand {
  kind: MobileCommandKind;
  sessionId: string;
  text?: string; // for send_message
  idempotencyKey: string;
}

export interface CommandAck {
  idempotencyKey: string;
  ok: boolean;
  error?: string;
}

/* ---------------- errors ---------------- */

export interface ProtocolError {
  code: string;
  message: string;
  retryable: boolean;
}

/* ---------------- chat mode (v1.7) ---------------- */

export interface ChatMessage {
  idempotencyKey: string; // non-empty, ≤128 chars
  sessionId?: string;
  text: string; // ≤32 KB; empty text with no fileIds is rejected
  fileIds?: string[];
  sentAt: number;
}

export interface ChatToken {
  idempotencyKey: string;
  seq: number;
  token: string;
}

export interface ChatDone {
  idempotencyKey: string;
  sessionId: string;
  ok: boolean;
  error?: string;
  at: number;
}

/* ---------------- secure file transfer (v1.7) ---------------- */

export interface FileOffer {
  transferId: string; // 128-bit random hex, client-generated
  name: string; // ≤255 chars
  mime: string; // allowlist: application/pdf, image/*, text/*, application/octet-stream
  sizeBytes: number; // ≤ 25 MB
  sha256: string; // hex SHA-256 of the complete file
}

export interface FileAccept {
  transferId: string;
}

export interface FileReject {
  transferId: string;
  reason: string;
}

export interface FileChunk {
  transferId: string;
  seq: number;
  data: string; // data: base64, decodes to ≤ 64 KB plaintext per chunk
}

export interface FileDone {
  transferId: string;
}

export interface FileReceived {
  transferId: string;
  fileId: string;
}

export interface FileError {
  transferId: string;
  code: string;
  message: string;
}

export interface ApprovalResult {
  approvalId: string;
  accepted: boolean;
}

export interface PairingIdentityProof {
  pairingVersion: 2;
  sentAt: number;
  mobileDeviceId: string;
  ref: string;
  helloPubkey: string;
  noisePublicKey: string;
  desktopPublicKey: string;
  signature: string;
}
