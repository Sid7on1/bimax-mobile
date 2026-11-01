# Bimax Mobile — Prompt #2: Relay server

Copy everything below the line into Antigravity as one prompt.

---

You are building the Bimax relay server. Context: Bimax mobile is a companion remote — the phone controls the desktop agent, it does not run the agent. The relay is a small service the desktop and the phone each connect to over a persistent websocket; every message routes phone → relay → desktop or desktop → relay → phone. The relay is a DUMB, OPAQUE PIPE: it routes by the envelope's `to` field and never inspects payloads (payloads become end-to-end encrypted in a later layer). The Prompt #1 scaffold (npm workspaces, @bimax/protocol, apps/mobile) already exists in this repo — do not recreate it.

STACK (exact, do not substitute):
- Node.js 20 LTS, TypeScript 5.x strict
- `ws` for websockets, `better-sqlite3` in WAL mode for the offline outbox + device registry. No web framework.

TASK:
1. FIRST, replace packages/protocol/src/index.ts with EXACTLY the v1.1 contents below (byte-identical). This is an architect-issued update — the only permitted edit to that package. It adds: required `to` on the envelope, the MessageKind union, DeviceHello, and DeliveryAck.

/**
 * @bimax/protocol v1.1 — wire protocol between the Bimax desktop engine
 * and the mobile companion app.
 *
 * PURE TYPES ONLY. No runtime code, no dependencies.
 * This package is owned by the architect. Do not edit without approval.
 *
 * v1.1 (2026-10-12, additive): Envelope gains required `to` (the relay
 * routes every message point-to-point); new MessageKind union of all known
 * kinds; new DeviceHello (first message on every websocket connection);
 * new DeliveryAck (client acks each drained outbox message so the relay
 * can delete it).
 */

export const PROTOCOL_VERSION = 1 as const;

/* ---------------- message kinds ---------------- */

export type MessageKind =
  | "hello"
  | "presence"
  | "session_list"
  | "transcript_chunk"
  | "approval_request"
  | "approval_decision"
  | "mobile_command"
  | "command_ack"
  | "pairing_request"
  | "pairing_grant"
  | "pairing_revoke"
  | "delivery_ack"
  | "error";

/* ---------------- transport envelope ---------------- */

export type DeviceRole = "desktop" | "mobile";

export interface Envelope<TKind extends string = MessageKind, TPayload = unknown> {
  v: typeof PROTOCOL_VERSION; // protocol version
  id: string;                 // client-generated stable id — idempotency key for retries
  ts: number;                 // unix millis, sender clock
  from: string;               // sender device id (public identifier)
  to: string;                 // recipient device id ("relay" for hello)
  kind: TKind;                // message kind
  payload: TPayload;
}

/* ---------------- hello (first message on every connection) ---------------- */

export interface DeviceHello {
  deviceId: string;
  role: DeviceRole;
  protocolVersion: number; // must equal PROTOCOL_VERSION, else the relay drops the socket
}

/* ---------------- delivery acks ---------------- */

export interface DeliveryAck {
  id: string; // envelope id being acknowledged
}

/* ---------------- pairing ---------------- */

export interface PairingAdvertisement {
  // Encoded in the QR code shown by the desktop app. `ref` rotates ~20s.
  relayUrl: string;
  ref: string;
  desktopDeviceId: string;
  desktopPublicKey: string; // base64 X25519
  app: "bimax";
}

export interface PairingRequest {
  ref: string;
  mobileDeviceId: string;
  mobilePublicKey: string; // base64 X25519
}

export interface PairingGrant {
  mobileDeviceId: string;
  grantedAt: number;
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
  | "running"
  | "paused"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "killed";

export interface SessionSummary {
  id: string;
  title: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
  repo?: string;
}

export interface SessionList {
  sessions: SessionSummary[];
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
  tool: string;       // e.g. "OS_COMMAND"
  summary: string;     // human-readable: what it wants to do
  detail: string;      // full command / arguments
  cwd?: string;
  requestedAt: number;
  expiresAt: number;   // expiry => treated as denied
}

export type ApprovalDecisionValue = "approved" | "denied";

export interface ApprovalDecision {
  approvalId: string;
  sessionId: string;
  decision: ApprovalDecisionValue;
  decidedAt: number;
  denyReason?: "not_me" | "mistake"; // "not_me" raises a security alert
  signature: string; // base64 Ed25519 over canonical bytes; desktop verifies
}

/* ---------------- commands: mobile -> desktop ---------------- */

export type MobileCommandKind =
  | "send_message"
  | "pause"
  | "resume"
  | "kill"
  | "request_approval_list";

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

2. Create apps/relay/ with exactly these files (do not invent more modules):
   apps/relay/
     package.json   (name "relay", private true, main "dist/index.js",
                     scripts: "build": "tsc -p tsconfig.json", "start": "node dist/index.js",
                     dependencies: ws, better-sqlite3;
                     devDependencies: "@types/ws", "@types/better-sqlite3")
     tsconfig.json  (extends ../../tsconfig.base.json, but OVERRIDES "module": "CommonJS"
                     and "moduleResolution": "node"; "outDir": "dist", "rootDir": "src", "include": ["src"])
     src/index.ts   (bootstrap: create HTTP server; GET /health → 200 {"ok": true};
                     upgrade websocket connections and hand them to the relay)
     src/relay.ts   (connection handling — the exact behavior in section 3)
     src/store.ts   (better-sqlite3 in WAL mode; the exact schema in section 4)
     test/smoke.mjs (plain Node script using the `ws` package as client; the exact
                     scenario in section 5)

3. BEHAVIOR (exact — implement precisely this):
   - Listen on PORT env var, default 8787.
   - The FIRST message on every socket MUST parse as Envelope<"hello", DeviceHello>.
     If it does not parse, or payload.protocolVersion !== 1, close the socket immediately.
   - Maintain a deviceId → socket registry. A second hello from the same deviceId
     replaces the old socket (stale session eviction).
   - v1 trusts hello as-is (no device authorization — that arrives in a later layer).
   - Routing: for every envelope after hello, read `to`.
     * If the target device is online: write the envelope to its socket immediately.
     * If the target is offline, or the socket write throws: persist the envelope to
       the SQLite outbox (JSON in the envelope column).
     * On every hello (including reconnects): drain that device's outbox rows in
       created_at order over the new socket. The client replies
       Envelope<"delivery_ack", DeliveryAck> per envelope id; delete a row only
       when its ack arrives. Rows never acked stay for the next drain (no duplicates
       on the client if it already processed an id — but the relay simply re-sends).
   - Presence: store last_seen per device (update on hello and on every message).
     After a device says hello, immediately send it Envelope<"presence", Presence>
     (from "relay") for every OTHER known device. On socket close, mark the device
     offline and send its offline presence to all currently online devices.
   - Never log or inspect envelope payloads beyond `to`/`kind`/`id` (opaque pipe).

4. DB SCHEMA (better-sqlite3, WAL mode via `db.pragma("journal_mode = WAL")`):
   CREATE TABLE IF NOT EXISTS outbox (
     id TEXT PRIMARY KEY,
     to_device TEXT NOT NULL,
     envelope TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_outbox_to ON outbox(to_device, created_at);
   CREATE TABLE IF NOT EXISTS devices (
     device_id TEXT PRIMARY KEY,
     role TEXT NOT NULL,
     last_seen INTEGER NOT NULL
   );
   Default DB path: ./relay.db next to the running dist (overridable via DB_PATH env).

5. SMOKE TEST — test/smoke.mjs must do exactly this (spawn the server itself):
   - Spawn `node dist/index.js` as a child process with PORT=18787 and DB_PATH set to a
     temp file; wait until GET http://127.0.0.1:18787/health returns {ok:true} (fail after 10s).
   - STEP 1 (live delivery): client A hellos as deviceId "desktop-1" role "desktop";
     client B hellos as deviceId "mobile-1" role "mobile". A sends
     Envelope<"session_list", SessionList> to B. Assert B receives it with the same id. PASS/FAIL.
   - STEP 2 (offline queue): B disconnects. A sends a second envelope (different id) to B.
     Assert B receives nothing within 1s. PASS/FAIL.
   - STEP 3 (drain + ack): B reconnects with a fresh hello. Assert B receives the queued
     envelope. B replies delivery_ack. Then B disconnects and reconnects AGAIN — assert
     B receives NOTHING this time (proves the ack deleted the row, no duplicate). PASS/FAIL.
   - STEP 4 (presence): assert that on B's first hello, B received presence envelopes for
     known devices. PASS/FAIL.
   - Print PASS/FAIL per step, kill the server child, exit 0 only if all pass.

SCOPE — DO NOT DO:
- No device authorization on hello, no E2E crypto, no mobile client code, no auth.
- No Fly.io/Docker/deploy files. No web framework, no ORM, no redis.
- Do not touch apps/mobile except if the protocol v1.1 change breaks its typecheck
  (it should not — fix minimally if it does).
- New dependencies allowed ONLY: ws, better-sqlite3, @types/ws, @types/better-sqlite3.

ACCEPTANCE (run at repo root unless noted, paste the FULL terminal output):
1. `npm install` → exit 0
2. `npx tsc --noEmit` → zero errors
3. `npx eslint .` → zero errors
4. `npx tsc -p apps/relay/tsconfig.json` → builds apps/relay/dist without errors
5. `node apps/relay/test/smoke.mjs` → all four steps PASS

RETURN FOR REVIEW (paste all five):
1. The file tree of apps/relay
2. The FULL text of packages/protocol/src/index.ts (it will be diffed byte-for-byte against v1.1)
3. apps/relay/package.json and apps/relay/tsconfig.json
4. The FULL output of the smoke test
5. The terminal output of acceptance commands 1–4
